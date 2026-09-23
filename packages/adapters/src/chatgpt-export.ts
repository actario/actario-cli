import { join } from 'node:path';
import type { UcfRunDraft, UcfTurn } from '@distill/ucf';
import type {
  AdapterCapabilities, AdapterResult, CaptureAdapter, CollectOpts, DetectResult, LocalEnv, RawUnit,
} from './types.ts';
import { absentFields } from './types.ts';
import { exists, iso, textUnit, walkFiles } from './util.ts';
import { readJsonFromZipOrFile, zipHasMember } from './zip.ts';

/**
 * ChatGPT account export (channel A). Plain chat: no tool calls, no artifacts.
 * Those absences are declared in `capabilities` so they cost no CQS points --
 * a chat-only user must not be told their capture quality is poor for a reason
 * they cannot fix (6.2).
 *
 * The export is a message *tree* (`mapping` + `current_node`), not a list.
 * Regenerations and edits are real branches, so this adapter linearises the
 * main path and keeps the alternatives as branch turns rather than dropping
 * them.
 */

const CAPABILITIES: AdapterCapabilities = {
  hasTurnTimestamps: true,
  hasToolCalls: false,
  hasArtifacts: false,
  hasBranches: true,
  hasOutcome: false,
};

interface Node {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[] };
    metadata?: Record<string, unknown>;
  } | null;
}

interface Conversation {
  title?: string;
  conversation_id?: string;
  id?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  mapping?: Record<string, Node>;
  [k: string]: unknown;
}

const KNOWN_CONV_KEYS = new Set([
  'title', 'conversation_id', 'id', 'create_time', 'update_time', 'current_node',
  'mapping', 'moderation_results', 'plugin_ids', 'conversation_template_id',
  'gizmo_id', 'is_archived', 'safe_urls', 'default_model_slug',
]);

/**
 * Detection is by content, not by filename.
 *
 * Matching `*claude*.zip` claimed `bp_prediction_pipeline_RF_claude.zip` -- an
 * ordinary project archive that happened to have the word in its name -- and
 * then reported "found" for a source that could never yield a conversation.
 * A detector that lies about what it found makes doctor useless, which is the
 * one thing doctor cannot be.
 *
 * So a candidate is a zip (or a bare conversations.json) that actually
 * contains a `conversations.json` member. Both export adapters accept the same
 * shape at this stage; which one owns a given file is settled by sniff(), and
 * the pipeline only degrades a unit when no adapter can parse it strictly.
 */
async function candidateExports(env: LocalEnv, nameHint: RegExp): Promise<string[]> {
  const roots = [env.downloadsDir, join(env.homedir, 'Desktop'), ...env.extraPaths];
  const found: string[] = [];

  for (const dir of roots) {
    if (!(await exists(dir))) continue;
    for (const f of await walkFiles(dir, (n) =>
      n === 'conversations.json' || n.toLowerCase().endsWith('.zip'), 1)) {
      if (f.endsWith('conversations.json')) { found.push(f); continue; }
      // Cheap: reads the archive tail and central directory, never a member.
      if (await zipHasMember(f, 'conversations.json')) found.push(f);
    }
  }
  // A name hint no longer decides anything, but it does decide order: the
  // likelier archive is checked first, so the right adapter usually claims it.
  return found.sort((a, b) => Number(nameHint.test(b)) - Number(nameHint.test(a)));
}

export const chatgptExport: CaptureAdapter = {
  id: 'chatgpt_export',
  version: '2026-01',
  capabilities: CAPABILITIES,

  async detect(env: LocalEnv): Promise<DetectResult> {
    const found = await candidateExports(env, /chatgpt|openai/i);
    return {
      found: found.length > 0,
      paths: found,
      approxUnits: found.length,
      note: found.length === 0
        ? 'No ChatGPT export found in Downloads or Desktop. Request one under Settings -> Data controls -> Export data, then run capture again; the zip does not need unpacking.'
        : undefined,
    };
  },

  async *collect(opts: CollectOpts): AsyncIterable<RawUnit> {
    const cutoff = opts.since ?? (opts.lastSeenAt ? new Date(opts.lastSeenAt) : undefined);
    for (const path of opts.paths) {
      const conversations = await readJsonFromZipOrFile<Conversation[]>(path, 'conversations.json');
      if (!Array.isArray(conversations)) continue;
      for (const conv of conversations) {
        const updated = iso((conv.update_time ?? conv.create_time ?? null) as number | null);
        if (cutoff && updated && new Date(updated) < cutoff) continue;
        const id = conv.conversation_id ?? conv.id ?? `${path}#${conversations.indexOf(conv)}`;
        // One conversation is one unit: a malformed conversation quarantines
        // itself and the other 900 in the same zip still land (6.3 rule 2).
        yield textUnit(id, path, JSON.stringify(conv), updated);
      }
    }
  },

  sniff(text: string): boolean {
    try {
      const o = JSON.parse(text) as Conversation;
      return !!o && typeof o === 'object' && typeof o.mapping === 'object' && o.mapping !== null;
    } catch {
      return false;
    }
  },

  toUCF(unit: RawUnit, text: string): AdapterResult {
    const conv = JSON.parse(text) as Conversation;
    const mapping = conv.mapping ?? {};

    // Walk the tree depth-first, main path first. Alternative children keep a
    // branch_id instead of being discarded.
    const turns: UcfTurn[] = [];
    const roots = Object.values(mapping).filter((n) => !n.parent || !mapping[n.parent]);
    let idx = 0;

    const visit = (node: Node, branchId: string | null, parentIdx: number | null) => {
      let myIdx = parentIdx;
      const msg = node.message;
      const role = msg?.author?.role;
      if (msg && role && role !== 'system') {
        const content = (msg.content?.parts ?? [])
          .map((p) => (typeof p === 'string' ? p : typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : ''))
          .filter(Boolean)
          .join('\n');
        if (content.trim().length > 0) {
          turns.push({
            idx,
            role: role === 'tool' ? 'assistant' : role,
            content,
            timestamp: iso(msg.create_time ?? null),
            tool_calls: null,
            branch_id: branchId,
            parent_turn_ref: parentIdx,
            truncated: false, tool_result: null, result_truncated: false,
            raw_ext: msg.metadata && Object.keys(msg.metadata).length > 0
              ? { metadata: msg.metadata }
              : {},
          });
          myIdx = idx;
          idx++;
        }
      }
      const kids = (node.children ?? []).map((c) => mapping[c]).filter((n): n is Node => !!n);
      kids.forEach((kid, i) => visit(kid, i === 0 ? branchId : kid.id, myIdx));
    };
    roots.forEach((r) => visit(r, null, null));

    if (turns.length === 0) return { runs: [], agents: [] };

    const times = turns.map((t) => t.timestamp).filter((t): t is string => t != null).sort();
    const convId = conv.conversation_id ?? conv.id ?? unit.unitId;
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(conv)) if (!KNOWN_CONV_KEYS.has(k)) extra[k] = conv[k];

    const run: UcfRunDraft = {
      run_ref: convId,
      agent_ref: null, // chat conversations go to the unbound queue; no guessing (13.3)
      platform: 'chatgpt',
      model: typeof conv.default_model_slug === 'string' ? conv.default_model_slug : null,
      started_at: iso(conv.create_time ?? null) ?? times[0] ?? null,
      ended_at: iso(conv.update_time ?? null) ?? times[times.length - 1] ?? null,
      outcome: null,
      title: conv.title ?? null,
      binding_hints: [{ type: 'conversation_id', value: convId }],
      turns,
      artifacts: [],
      parse_level: 'strict',
      adapter_id: 'chatgpt_export',
      adapter_version: '2026-01',
      degraded_fields: times.length === 0 ? ['turn_timestamps'] : [],
      absent_by_capability: absentFields(CAPABILITIES),
      raw_ext: extra,
    };
    return { runs: [run], agents: [] };
  },
};
