import { join } from 'node:path';
import type { UcfRunDraft, UcfTurn } from '@distill/ucf';
import type {
  AdapterCapabilities, AdapterResult, CaptureAdapter, CollectOpts, DetectResult, LocalEnv, RawUnit,
} from './types.ts';
import { absentFields } from './types.ts';
import { blocksToText, exists, iso, textUnit, walkFiles } from './util.ts';
import { readJsonFromZipOrFile, zipHasMember } from './zip.ts';

/** Claude account export (channel A). Flat message list, no tools, no artifacts. */
const CAPABILITIES: AdapterCapabilities = {
  hasTurnTimestamps: true,
  hasToolCalls: false,
  hasArtifacts: false,
  hasBranches: false,
  hasOutcome: false,
};

interface ClaudeMessage {
  uuid?: string;
  text?: string;
  content?: unknown;
  sender?: string;
  created_at?: string;
  [k: string]: unknown;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
  [k: string]: unknown;
}

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

export const claudeExport: CaptureAdapter = {
  id: 'claude_export',
  version: '2026-01',
  capabilities: CAPABILITIES,

  async detect(env: LocalEnv): Promise<DetectResult> {
    const found = await candidateExports(env, /claude/i);
    return {
      found: found.length > 0,
      paths: found,
      approxUnits: found.length,
      note: found.length === 0
        ? 'No Claude export found in Downloads or Desktop. Request one under Settings -> Privacy -> Export data.'
        : undefined,
    };
  },

  async *collect(opts: CollectOpts): AsyncIterable<RawUnit> {
    const cutoff = opts.since ?? (opts.lastSeenAt ? new Date(opts.lastSeenAt) : undefined);
    for (const path of opts.paths) {
      const convs = await readJsonFromZipOrFile<ClaudeConversation[]>(path, 'conversations.json');
      if (!Array.isArray(convs)) continue;
      for (const conv of convs) {
        const updated = iso(conv.updated_at ?? conv.created_at ?? null);
        if (cutoff && updated && new Date(updated) < cutoff) continue;
        yield textUnit(conv.uuid ?? `${path}#${convs.indexOf(conv)}`, path, JSON.stringify(conv), updated);
      }
    }
  },

  sniff(text: string): boolean {
    try {
      const o = JSON.parse(text) as ClaudeConversation;
      return !!o && Array.isArray(o.chat_messages);
    } catch {
      return false;
    }
  },

  toUCF(unit: RawUnit, text: string): AdapterResult {
    const conv = JSON.parse(text) as ClaudeConversation;
    const msgs = conv.chat_messages ?? [];
    const turns: UcfTurn[] = [];

    msgs.forEach((m, i) => {
      const content = (m.text && m.text.length > 0) ? m.text : blocksToText(m.content);
      if (!content || content.trim().length === 0) return;
      const known = new Set(['uuid', 'text', 'content', 'sender', 'created_at', 'updated_at', 'attachments', 'files']);
      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(m)) if (!known.has(k)) extra[k] = m[k];
      turns.push({
        idx: turns.length,
        role: m.sender === 'human' ? 'user' : 'assistant',
        content,
        timestamp: iso(m.created_at ?? null),
        tool_calls: null,
        branch_id: null,
        parent_turn_ref: turns.length > 0 ? turns.length - 1 : null,
        truncated: false, tool_result: null, result_truncated: false,
        raw_ext: extra,
      });
      void i;
    });

    if (turns.length === 0) return { runs: [], agents: [] };
    const times = turns.map((t) => t.timestamp).filter((t): t is string => t != null).sort();
    const convId = conv.uuid ?? unit.unitId;

    const run: UcfRunDraft = {
      run_ref: convId,
      agent_ref: null,
      platform: 'claude',
      model: null,
      started_at: iso(conv.created_at ?? null) ?? times[0] ?? null,
      ended_at: iso(conv.updated_at ?? null) ?? times[times.length - 1] ?? null,
      outcome: null,
      title: conv.name ?? null,
      binding_hints: [{ type: 'conversation_id', value: convId }],
      turns,
      artifacts: [],
      parse_level: 'strict',
      adapter_id: 'claude_export',
      adapter_version: '2026-01',
      degraded_fields: times.length === 0 ? ['turn_timestamps'] : [],
      absent_by_capability: absentFields(CAPABILITIES),
      raw_ext: {},
    };
    return { runs: [run], agents: [] };
  },
};
