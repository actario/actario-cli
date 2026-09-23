import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { DIFF_BODY_MAX_CHARS, TOOL_PARAM_MAX_CHARS, TOOL_RESULT_MAX_BYTES } from '@distill/ucf';
import type { BindingHint, UcfArtifact, UcfRunDraft, UcfTurn, ToolCall } from '@distill/ucf';
import type {
  ParseOpts,
  AdapterCapabilities, AdapterResult, CaptureAdapter, CollectOpts, DetectResult, LocalEnv, RawUnit,
} from './types.ts';
import { absentFields } from './types.ts';
import { capBytes, capChars, exists, fileUnit, iso, splitBlocks, walkFiles } from './util.ts';

/**
 * Claude Code session adapter.
 *
 * This is the only M1 source that carries tool calls and artifacts, which
 * makes it both the most valuable and the most fragile: the jsonl layout
 * changes without an announcement (R13). Two structural answers, per 6.3:
 *
 *   - The adapter is versioned by *date* and versions coexist. A new layout is
 *     a new file in this directory, never an edit to an existing one, so the
 *     old golden fixtures keep passing forever (6.3 rule 3).
 *   - `sniff()` decides whether this version applies. Every version failing
 *     its sniff is not an error: the caller falls back to the L2 loose parser.
 *
 * Recognised keys that turn out to be unknown are preserved in `raw_ext`
 * rather than dropped (6.3 rule 1).
 */

const CAPABILITIES: AdapterCapabilities = {
  hasTurnTimestamps: true,
  hasToolCalls: true,
  hasArtifacts: true,
  hasBranches: true,
  hasOutcome: true,
};

/** Tools whose invocation means a file on disk changed. */
const WRITE_TOOLS = new Map<string, UcfArtifact['change']>([
  ['Write', 'created'],
  ['Edit', 'modified'],
  ['MultiEdit', 'modified'],
  ['NotebookEdit', 'modified'],
]);

/** How many non-empty lines sniff() will look at before giving up. */
const SNIFF_LINES = 40;

const KNOWN_RECORD_KEYS = new Set([
  'type', 'message', 'uuid', 'parentUuid', 'timestamp', 'sessionId', 'cwd',
  'version', 'gitBranch', 'isSidechain', 'userType', 'requestId', 'toolUseResult',
  'isMeta', 'summary', 'leafUuid',
  // ── Observed on a real 2026-09 install (49 sessions, 4,466 records) ──
  // Recognised so doctor stops reporting them as noise; still carried in
  // raw_ext so nothing is lost. Three groups are worth naming:
  //
  //  outcome   stopReason / apiErrorStatus / isApiErrorMessage / error /
  //            preventedContinuation -- the real reason a run ended. Until
  //            now `outcome` was inferred from "the last turn was the
  //            assistant", which is a guess dressed as a fact.
  //  attribution  agentId / attributionAgent / attributionSkill /
  //            attributionPlugin / attributionMcpServer / attributionMcpTool
  //            -- which agent, skill, plugin or MCP tool produced this record.
  //            The plan assumed this had to be reconstructed by analysis; the
  //            format now records it, which is a gift to resolve-agent.
  //  linkage   toolUseID / sourceToolUseID -- ties a tool result back to the
  //            call that asked for it.
  'agentId', 'attributionAgent', 'attributionSkill', 'attributionPlugin',
  'attributionMcpServer', 'attributionMcpTool',
  'toolUseID', 'sourceToolUseID', 'sourceToolAssistantUUID',
  'stopReason', 'apiErrorStatus', 'isApiErrorMessage', 'error',
  'preventedContinuation', 'subtype', 'level',
  'promptId', 'promptSource', 'lastPrompt', 'entrypoint', 'origin',
  'permissionMode', 'mode', 'operation', 'attachment', 'content',
  'hasOutput', 'hookCount', 'hookErrors', 'hookInfos', 'atis',
]);

/** Keys whose value identifies the agent, skill or tool behind a record. */
const ATTRIBUTION_KEYS = [
  'agentId', 'attributionAgent', 'attributionSkill', 'attributionPlugin',
  'attributionMcpServer', 'attributionMcpTool',
] as const;

interface Record_ { [k: string]: unknown }

function sessionDirs(env: LocalEnv): string[] {
  const home = env.homedir || homedir();
  return [join(home, '.claude', 'projects'), ...env.extraPaths];
}

/** Claude Code encodes the project path into the directory name. */
function decodeProjectPath(dir: string): string | null {
  const name = basename(dir);
  if (!name.startsWith('-')) return null;
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

export const claudeCodeSession2026_08: CaptureAdapter = {
  id: 'claude_code_session',
  version: '2026-08',
  capabilities: CAPABILITIES,

  async detect(env: LocalEnv): Promise<DetectResult> {
    const roots: string[] = [];
    for (const d of sessionDirs(env)) if (await exists(d)) roots.push(d);
    if (roots.length === 0) {
      return {
        found: false,
        paths: [],
        approxUnits: 0,
        note: 'No ~/.claude/projects directory. Claude Code has either never run on this machine or stores sessions elsewhere; add the path under "extraPaths" in ~/.actario/config.json.',
      };
    }
    const files = (await Promise.all(
      roots.map((r) => walkFiles(r, (n) => n.endsWith('.jsonl'))),
    )).flat();
    return { found: files.length > 0, paths: roots, approxUnits: files.length };
  },

  async *collect(opts: CollectOpts): AsyncIterable<RawUnit> {
    const cutoff = opts.since ?? (opts.lastSeenAt ? new Date(opts.lastSeenAt) : undefined);
    for (const root of opts.paths) {
      const files = await walkFiles(root, (n) => n.endsWith('.jsonl'));
      for (const f of files) {
        const unit = await fileUnit(f);
        // mtime is a cheap pre-filter only. The authoritative dedupe is the
        // server-side content_hash, because mtime lies after a file copy.
        if (cutoff && unit.mtime && new Date(unit.mtime) < cutoff) continue;
        yield unit;
      }
    }
  },

  sniff(text: string): boolean {
    /**
     * Scan the first several lines, not just the first one.
     *
     * A session file does not have to open with a message. Claude Code writes
     * `{"type":"summary",...}` records and various metadata envelopes, and any
     * of them can come first. Judging the format on line 1 alone sent whole
     * files -- fully parseable ones -- down to the loose parser, which then
     * reported their tool records as "unreadable" and dragged CQS down for no
     * reason. On one real machine that was 7 of 49 sessions.
     *
     * The rule is therefore: does *any* line near the top look like the shape
     * this version handles.
     */
    let checked = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (++checked > SNIFF_LINES) break;
      try {
        const o = JSON.parse(line) as Record_;
        // The 2026-08 shape: a typed envelope wrapping an Anthropic message.
        if (
          typeof o.type === 'string' &&
          typeof o.message === 'object' &&
          o.message !== null &&
          ('uuid' in o || 'sessionId' in o)
        ) return true;
      } catch {
        // A single unreadable line says nothing about the file's format.
      }
    }
    return false;
  },

  toUCF(unit: RawUnit, text: string, opts: ParseOpts = {}): AdapterResult {
    const uploadDiffs = opts.uploadDiffs ?? true;
    const records: Record_[] = [];
    let malformedLines = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t) as Record_); } catch { malformedLines++; }
    }

    const turns: UcfTurn[] = [];
    const artifacts = new Map<string, UcfArtifact>();
    const unknownKeys = new Set<string>();
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let model: string | null = null;
    let gitBranch: string | null = null;
    let sawToolUse = false;
    let sawWriteTool = false;
    let stopReason: string | null = null;
    let sawApiError = false;
    let preventedContinuation = false;
    const attribution = new Map<string, Set<string>>();
    let idx = 0;
    const uuidToIdx = new Map<string, number>();

    for (const rec of records) {
      for (const k of Object.keys(rec)) if (!KNOWN_RECORD_KEYS.has(k)) unknownKeys.add(k);

      // Outcome evidence, wherever it appears in the file.
      if (typeof rec.stopReason === 'string') stopReason = rec.stopReason;
      if (rec.isApiErrorMessage === true || typeof rec.apiErrorStatus === 'number') sawApiError = true;
      if (rec.preventedContinuation === true) preventedContinuation = true;
      for (const k of ATTRIBUTION_KEYS) {
        const v = rec[k];
        if (typeof v === 'string' && v.length > 0) {
          (attribution.get(k) ?? attribution.set(k, new Set()).get(k)!).add(v);
        }
      }

      sessionId ??= typeof rec.sessionId === 'string' ? rec.sessionId : null;
      cwd ??= typeof rec.cwd === 'string' ? rec.cwd : null;
      gitBranch ??= typeof rec.gitBranch === 'string' ? rec.gitBranch : null;

      const msg = rec.message as Record_ | undefined;
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof msg.role === 'string' ? msg.role : (rec.type as string | undefined);
      if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system')) continue;
      if (typeof msg.model === 'string') model ??= msg.model;

      const { text: content, toolResult } = splitBlocks(msg.content);
      const capped = toolResult != null ? capBytes(toolResult, TOOL_RESULT_MAX_BYTES) : null;
      const toolCalls: ToolCall[] = [];

      if (Array.isArray(msg.content)) {
        for (const b of msg.content as Record_[]) {
          if (!b || b.type !== 'tool_use') continue;
          sawToolUse = true;
          const name = typeof b.name === 'string' ? b.name : 'unknown';
          const input = (b.input ?? {}) as Record<string, unknown>;
          toolCalls.push({ name, params: capParams(input), raw_ext: {} });

          const change = WRITE_TOOLS.get(name);
          if (change) sawWriteTool = true;
          const path = typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.path === 'string' ? input.path : null;
          if (change && path && !artifacts.has(path)) {
            artifacts.set(path, {
              path,
              change,
              diff_summary: summariseEdit(name, input),
              // v1.2: the body travels too, unless the source switched it off.
              diff_body: uploadDiffs ? diffBody(name, input) : null,
              sha256: null,
              raw_ext: {},
            });
          }
        }
      }

      const parentUuid = typeof rec.parentUuid === 'string' ? rec.parentUuid : null;
      const parentIdx = parentUuid != null ? uuidToIdx.get(parentUuid) ?? null : null;
      if (typeof rec.uuid === 'string') uuidToIdx.set(rec.uuid, idx);

      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(rec)) if (!KNOWN_RECORD_KEYS.has(k)) extra[k] = rec[k];

      turns.push({
        idx,
        role,
        content,
        timestamp: iso(rec.timestamp),
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        // A sidechain is a real branch of the conversation, not a separate run.
        branch_id: rec.isSidechain === true ? 'sidechain' : null,
        parent_turn_ref: parentIdx,
        truncated: false,
        tool_result: capped?.text ?? null,
        result_truncated: capped?.truncated ?? false,
        raw_ext: extra,
      });
      idx++;
    }

    if (turns.length === 0) return { runs: [], agents: [] };

    const times = turns.map((t) => t.timestamp).filter((t): t is string => t != null).sort();
    const repoPath = cwd ?? decodeProjectPath(dirname(unit.path));
    const bindingHints: BindingHint[] = repoPath
      ? [{ type: 'repo_path', value: repoPath }]
      : [];
    if (sessionId) bindingHints.push({ type: 'conversation_id', value: sessionId });

    /**
     * Degraded means "should have been here and could not be read"; absent
     * means "was never here" (6.2). Applied to artifacts, that distinction has
     * three cases, not two -- and collapsing them produces a confident, wrong
     * accusation of a format change:
     *
     *   no tool_use blocks at all      -> tool_calls degraded. This is the
     *                                     loud format-change signal.
     *   tool calls, but no write tool  -> nothing was written. Common and
     *                                     entirely normal: a session that
     *                                     edits files via Bash, sed or a
     *                                     script produces no Write/Edit call
     *                                     and therefore no artifacts. Absent,
     *                                     not degraded, and it costs no CQS.
     *   write tool, but no path found  -> genuinely unreadable. Degraded.
     */
    const degraded: string[] = [];
    const absent = absentFields(CAPABILITIES);
    if (!sawToolUse) degraded.push('tool_calls');
    if (sawWriteTool && artifacts.size === 0) degraded.push('artifacts');
    else if (sawToolUse && !sawWriteTool) absent.push('artifacts');
    if (times.length === 0) degraded.push('turn_timestamps');
    if (stopReason === null && !sawApiError) degraded.push('outcome');
    if (malformedLines > 0) degraded.push('malformed_lines');

    const run: UcfRunDraft = {
      run_ref: sessionId ?? unit.unitId,
      agent_ref: repoPath,
      platform: 'claude_code',
      model,
      started_at: times[0] ?? null,
      ended_at: times[times.length - 1] ?? null,
      outcome: deriveOutcome({
        stopReason,
        sawApiError,
        preventedContinuation,
        lastRole: turns[turns.length - 1]?.role,
      }),
      title: repoPath ? `${basename(repoPath)} session` : basename(unit.path),
      binding_hints: bindingHints,
      turns,
      artifacts: [...artifacts.values()],
      parse_level: 'strict',
      adapter_id: 'claude_code_session',
      adapter_version: '2026-08',
      degraded_fields: degraded,
      absent_by_capability: absent,
      raw_ext: {
        ...(gitBranch ? { git_branch: gitBranch } : {}),
        ...(stopReason ? { stop_reason: stopReason } : {}),
        ...(sawApiError ? { api_error: true } : {}),
        // Kept in one place rather than scattered through turn raw_ext, so
        // resolve-agent has somewhere obvious to look (week 4).
        ...(attribution.size > 0
          ? {
              attribution: Object.fromEntries(
                [...attribution.entries()].map(([k, v]) => [k, [...v].sort()]),
              ),
            }
          : {}),
        ...(unknownKeys.size > 0 ? { unknown_record_keys: [...unknownKeys].sort() } : {}),
        ...(malformedLines > 0 ? { malformed_lines: malformedLines } : {}),
      },
    };

    const agents = repoPath
      ? [{
          agent_ref: repoPath,
          name: `${basename(repoPath)} coding session`,
          kind: 'coding_session' as const,
          bindings: [{ type: 'repo_path' as const, value: repoPath }],
          raw_ext: {},
        }]
      : [];

    return { runs: [run], agents };
  },
};

/**
 * Caps tool parameters without eliding them (v1.2; plan 5.6.1).
 *
 * v1.1 replaced file bodies with `{ _elided, lines, chars }` so the user's
 * source never left the machine through the back door. v1.4 reverses that
 * deliberately: the widened upload scope is what makes the de-identified
 * corpus worth building, and hard redaction has already run over every
 * string by the time this leaves the machine (C6 -- unchanged, and not
 * loosened by the wider scope).
 *
 * What survives from the old rule is the size cap, and it must: the ADR that
 * recorded the original leak noted that Claude Code's `Write` carries the
 * whole file in `input.content`. Widening the scope without a cap would be
 * that bug again with a policy attached.
 */
const MAX_PARAM_CHARS = TOOL_PARAM_MAX_CHARS;

function capParams(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = capChars(v, MAX_PARAM_CHARS);
    else if (Array.isArray(v)) {
      out[k] = v.map((e) =>
        e && typeof e === 'object' && !Array.isArray(e)
          ? capParams(e as Record<string, unknown>)
          : typeof e === 'string' ? capChars(e, MAX_PARAM_CHARS) : e,
      );
    } else if (v && typeof v === 'object') out[k] = capParams(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/**
 * A readable diff body for the artifact (v1.2). Not a real unified diff --
 * the adapter never sees the file on disk, only the tool call -- but the two
 * sides of an Edit and the whole of a Write are exactly what a reader (or a
 * training sample) needs.
 */
function diffBody(tool: string, input: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  let body: string | null = null;
  if (tool === 'Write') body = str(input.content);
  else if (tool === 'Edit') {
    const o = str(input.old_string) ?? str(input.old_str);
    const n = str(input.new_string) ?? str(input.new_str);
    if (o != null || n != null) body = `--- old\n${o ?? ''}\n+++ new\n${n ?? ''}`;
  } else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    body = (input.edits as Record<string, unknown>[])
      .map((e) => `--- old\n${str(e.old_string) ?? ''}\n+++ new\n${str(e.new_string) ?? ''}`)
      .join('\n');
  }
  return body == null ? null : capChars(body, DIFF_BODY_MAX_CHARS);
}

function summariseEdit(tool: string, input: Record<string, unknown>): string | null {
  const countLines = (s: unknown) => (typeof s === 'string' ? s.split('\n').length : 0);
  if (tool === 'Write') return `+${countLines(input.content)} -0`;
  if (tool === 'Edit') {
    return `+${countLines(input.new_string)} -${countLines(input.old_string)}`;
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let add = 0, del = 0;
    for (const e of input.edits as Record<string, unknown>[]) {
      add += countLines(e.new_string);
      del += countLines(e.old_string);
    }
    return `+${add} -${del}`;
  }
  return null;
}

/**
 * The real reason a run ended, in priority order of evidence.
 *
 * An API error outranks everything: a run that died on a 529 did not complete,
 * whatever its last message looks like. `stopReason` is the format's own
 * answer and is trusted next. Falling back to "the last turn was the
 * assistant" is last, and it is what the whole run used to rest on -- a guess
 * that reads as a fact, which is worse than a missing field.
 */
function deriveOutcome(ev: {
  stopReason: string | null;
  sawApiError: boolean;
  preventedContinuation: boolean;
  lastRole: string | undefined;
}): 'completed' | 'interrupted' | 'failed' | 'ongoing' {
  if (ev.sawApiError) return 'failed';
  if (ev.preventedContinuation) return 'interrupted';
  switch (ev.stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'completed';
    case 'max_tokens':
    case 'refusal':
      return 'interrupted';
    case 'tool_use':
      // Stopped waiting on a tool and never came back.
      return 'ongoing';
    default:
      return ev.lastRole === 'assistant' ? 'completed' : 'interrupted';
  }
}
