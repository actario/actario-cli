import { join } from 'node:path';
import type { BindingHint, UcfRunDraft, UcfTurn, ToolCall } from '@distill/ucf';
import type {
  AdapterCapabilities, AdapterResult, CaptureAdapter, CollectOpts, DetectResult, LocalEnv, RawUnit,
} from './types.ts';
import { absentFields } from './types.ts';
import { exists, fileUnit, iso, walkFiles } from './util.ts';
import { actarioEnv, resolveActarioHome } from '@distill/shared';

/**
 * The live-conversation channel (`distill.chat/v1`).
 *
 * Every other adapter reads a log some tool wrote. This one reads a record an
 * assistant wrote about the conversation it is currently in, which covers the
 * one place Actario was otherwise blind: Cowork and claude.ai keep no session
 * file on the machine, so there is nothing on disk for an adapter to find. In
 * Claude Code the transcript does land as jsonl and
 * `claude_code_session` already handles it -- this channel is for everywhere
 * else.
 *
 * The division of labour is deliberate and follows 5.2: the Skill only writes
 * a file in a documented shape into `~/.actario/inbox/`. It performs no
 * redaction, no scoring, no packing. Those all happen here, in the same
 * pipeline every other source goes through, which is what keeps the
 * unconditional credential rules (C6) unconditional -- a capture path that did
 * its own redaction would be a second place for that guarantee to be wrong.
 */

/**
 * Every capability is false, and that is the correct declaration rather than
 * pessimism (6.2).
 *
 * A written record structurally guarantees roles and content and nothing else.
 * Claiming it "has" tool calls would make their absence a degradation and cost
 * CQS points for something the user cannot act on -- exactly the mistake that
 * makes a quality score worth ignoring. Tools and timestamps, when the record
 * happens to carry them, are a bonus that costs nothing.
 */
const CAPABILITIES: AdapterCapabilities = {
  hasTurnTimestamps: false,
  hasToolCalls: false,
  hasArtifacts: false,
  hasBranches: false,
  hasOutcome: false,
};

export const CHAT_FORMAT = 'distill.chat/v1' as const;

interface ChatToolNote { name?: unknown; summary?: unknown }
interface ChatTurn {
  role?: unknown;
  content?: unknown;
  at?: unknown;
  tools?: unknown;
  [k: string]: unknown;
}
interface ChatRecord {
  format?: unknown;
  platform?: unknown;
  conversation_id?: unknown;
  title?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  outcome?: unknown;
  model?: unknown;
  project?: unknown;
  repo_path?: unknown;
  turns?: unknown;
  [k: string]: unknown;
}

const KNOWN_TOP = new Set([
  'format', 'platform', 'conversation_id', 'title', 'started_at', 'ended_at',
  'outcome', 'project', 'repo_path', 'turns', 'model',
]);
const KNOWN_TURN = new Set(['role', 'content', 'at', 'tools']);

/** Where the Skill drops records. Kept under ~/.actario so it travels with
 *  the rest of the machine-local state (13.1). Goes through the same resolver
 *  as the config dir: a skill that created ~/.actario/inbox on its own would
 *  otherwise leave a pre-rename ~/.actario sitting there unmigrated. */
export const inboxDir = (env: LocalEnv): string =>
  join(actarioEnv('HOME') ?? resolveActarioHome(env.homedir), 'inbox');

const normaliseRole = (v: unknown): string => {
  const r = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (r === 'human' || r === 'me' || r === 'user') return 'user';
  if (r === 'assistant' || r === 'ai' || r === 'claude' || r === 'model') return 'assistant';
  return r.length > 0 ? r.slice(0, 32) : 'unknown';
};

export const coworkLive: CaptureAdapter = {
  id: 'cowork_live',
  version: '1',
  capabilities: CAPABILITIES,

  async detect(env: LocalEnv): Promise<DetectResult> {
    const dir = inboxDir(env);
    if (!(await exists(dir))) {
      return {
        found: false, paths: [], approxUnits: 0,
        note: `No conversation records yet. Ask Claude to record the current conversation and it writes one into ${dir}.`,
      };
    }
    const files = await walkFiles(dir, (n) => n.endsWith('.chat.json'), 1);
    return {
      found: files.length > 0,
      paths: [dir],
      approxUnits: files.length,
      note: files.length === 0
        ? `${dir} is empty. Ask Claude to record the current conversation.`
        : undefined,
    };
  },

  async *collect(opts: CollectOpts): AsyncIterable<RawUnit> {
    const cutoff = opts.since ?? (opts.lastSeenAt ? new Date(opts.lastSeenAt) : undefined);
    for (const dir of opts.paths) {
      for (const f of await walkFiles(dir, (n) => n.endsWith('.chat.json'), 1)) {
        const unit = await fileUnit(f);
        // Records are never deleted after capture: the server deduplicates on
        // content hash, so a re-read is free, and a file the user can still
        // see is easier to trust than one that vanished.
        if (cutoff && unit.mtime && new Date(unit.mtime) < cutoff) continue;
        yield unit;
      }
    }
  },

  sniff(text: string): boolean {
    try {
      const o = JSON.parse(text) as ChatRecord;
      return !!o && o.format === CHAT_FORMAT && Array.isArray(o.turns);
    } catch {
      return false;
    }
  },

  toUCF(unit: RawUnit, text: string): AdapterResult {
    const rec = JSON.parse(text) as ChatRecord;
    const rawTurns = Array.isArray(rec.turns) ? (rec.turns as ChatTurn[]) : [];

    const turns: UcfTurn[] = [];
    const unknownTurnKeys = new Set<string>();
    let sawTools = false;

    for (const t of rawTurns) {
      const content = typeof t.content === 'string' ? t.content : '';
      if (content.trim().length === 0) continue;

      const tools: ToolCall[] = [];
      if (Array.isArray(t.tools)) {
        for (const raw of t.tools as (ChatToolNote | string)[]) {
          const name = typeof raw === 'string' ? raw
            : typeof raw?.name === 'string' ? raw.name : null;
          if (!name) continue;
          sawTools = true;
          // A summary, never invented parameters. The record is written by an
          // assistant describing what it did; fabricating argument values
          // would put unverifiable detail into the source of truth.
          const summary = typeof (raw as ChatToolNote)?.summary === 'string'
            ? (raw as ChatToolNote).summary as string
            : undefined;
          tools.push({ name, ...(summary ? { params: { summary } } : {}), raw_ext: {} });
        }
      }

      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(t)) {
        if (KNOWN_TURN.has(k)) continue;
        extra[k] = t[k];
        unknownTurnKeys.add(k);
      }

      turns.push({
        idx: turns.length,
        role: normaliseRole(t.role),
        content,
        timestamp: iso(t.at),
        tool_calls: tools.length > 0 ? tools : null,
        branch_id: null,
        parent_turn_ref: turns.length > 0 ? turns.length - 1 : null,
        truncated: false, tool_result: null, result_truncated: false,
        raw_ext: extra,
      });
    }

    if (turns.length === 0) return { runs: [], agents: [] };

    const times = turns.map((t) => t.timestamp).filter((v): v is string => v != null).sort();
    const startedAt = iso(rec.started_at) ?? times[0] ?? unit.mtime;
    const endedAt = iso(rec.ended_at) ?? times[times.length - 1] ?? unit.mtime;

    const bindingHints: BindingHint[] = [];
    if (typeof rec.repo_path === 'string' && rec.repo_path) {
      bindingHints.push({ type: 'repo_path', value: rec.repo_path });
    }
    if (typeof rec.conversation_id === 'string' && rec.conversation_id) {
      bindingHints.push({ type: 'conversation_id', value: rec.conversation_id });
    }
    if (typeof rec.project === 'string' && rec.project) {
      bindingHints.push({ type: 'project_hint', value: rec.project });
    }

    const extraTop: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) if (!KNOWN_TOP.has(k)) extraTop[k] = rec[k];

    // Nothing is declared degraded. Everything this source does not carry is
    // absent by capability, so a plain narrative record scores as well as an
    // instrumented one -- and a low score means something the user can fix.
    const absent = absentFields(CAPABILITIES).filter(
      (f) => !(f === 'tool_calls' && sawTools),
    );
    // `model` is optional in the format, so its absence is a property of the
    // source rather than a failed read. Left off this list it would be scored
    // as "expected but unreadable" on every record -- a permanent deduction
    // for something no narrative record can supply.
    const model = typeof rec.model === 'string' && rec.model ? rec.model : null;
    if (!model) absent.push('model');

    const outcome = typeof rec.outcome === 'string'
      && ['completed', 'interrupted', 'failed', 'ongoing'].includes(rec.outcome)
      ? rec.outcome as 'completed' | 'interrupted' | 'failed' | 'ongoing'
      : null;

    const run: UcfRunDraft = {
      run_ref: typeof rec.conversation_id === 'string' && rec.conversation_id
        ? rec.conversation_id
        : unit.unitId,
      agent_ref: null,   // resolve-agent decides from the hints; never guessed here
      platform: typeof rec.platform === 'string' && rec.platform ? rec.platform : 'cowork',
      model,
      started_at: startedAt,
      ended_at: endedAt,
      outcome,
      title: typeof rec.title === 'string' ? rec.title : null,
      binding_hints: bindingHints,
      turns,
      artifacts: [],
      parse_level: 'strict',
      adapter_id: 'cowork_live',
      adapter_version: '1',
      degraded_fields: [],
      absent_by_capability: absent,
      raw_ext: {
        chat_format: CHAT_FORMAT,
        source_file: unit.path.split(/[\\/]/).pop() ?? unit.path,
        ...(unknownTurnKeys.size > 0
          ? { unrecognised_turn_keys: [...unknownTurnKeys].sort() } : {}),
        ...extraTop,
      },
    };

    // A named project or repo is an explicit binding, not a guess, so the
    // agent may be declared here (see fn:ingest upsertAgents).
    const agentRef = typeof rec.repo_path === 'string' && rec.repo_path
      ? rec.repo_path
      : typeof rec.project === 'string' && rec.project ? rec.project : null;

    if (agentRef) {
      run.agent_ref = agentRef;
      return {
        runs: [run],
        agents: [{
          agent_ref: agentRef,
          name: typeof rec.project === 'string' && rec.project
            ? `${rec.project} conversations`
            : `${agentRef.split(/[\\/]/).pop()} conversations`,
          kind: 'chat_role',
          bindings: bindingHints.filter((h) => h.type !== 'conversation_id'),
          raw_ext: {},
        }],
      };
    }

    return { runs: [run], agents: [] };
  },
};
