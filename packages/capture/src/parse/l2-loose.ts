import { parseLooseDate } from '@distill/shared';
import type { RawUnit } from '@distill/adapters';
import type { UcfRunDraft, UcfTurn } from '@distill/ucf';

/**
 * L2: structure guessing (6.3).
 *
 * Runs when every strict adapter version rejected the unit. The assumption is
 * that the file is still JSON or JSONL and still a conversation -- somebody
 * renamed the keys or moved the nesting. So: find something that looks like a
 * role, something that looks like content, and any parseable timestamp.
 *
 * What comes out has no tool calls and no artifacts, and says so. That is the
 * point: the user's experience of a format change becomes "this batch lost the
 * tool records" instead of "this batch is empty", and one empty capture is
 * enough for someone to stop running the Skill (R17).
 */

const ROLE_KEYS = ['role', 'speaker', 'author', 'sender', 'from', 'user_type', 'type'];
const CONTENT_KEYS = ['content', 'text', 'message', 'body', 'parts', 'value', 'msg', 'prompt', 'completion'];
const TIME_KEYS = ['timestamp', 'time', 'created_at', 'create_time', 'createdAt', 'date', 'ts', 'at', 'sent_at'];
const ROLE_ALIASES: Record<string, string> = {
  human: 'user', me: 'user', prompt: 'user', question: 'user', request: 'user',
  ai: 'assistant', bot: 'assistant', model: 'assistant', gpt: 'assistant',
  claude: 'assistant', answer: 'assistant', completion: 'assistant', response: 'assistant',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function pickShallow(o: Obj, keys: string[]): { key: string; value: unknown } | null {
  for (const k of keys) {
    if (k in o && o[k] != null && o[k] !== '') return { key: k, value: o[k] };
  }
  // Case-insensitive second pass: `Role`, `CONTENT`, `createdAT`.
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const actual = lower.get(k.toLowerCase());
    if (actual && o[actual] != null && o[actual] !== '') return { key: actual, value: o[actual] };
  }
  return null;
}

/**
 * Same search, but willing to look inside a wrapper object.
 *
 * Formats love wrappers: ChatGPT writes `author: { role }`, and the fixture in
 * __fixtures__/broken writes `who: { role }` and `payload: { text }`. Refusing
 * to descend one level would send every wrapped format to the plain-text floor
 * even though the conversation is plainly readable.
 *
 * The returned `key` is the *top-level* key, so the caller still knows which
 * of the object's own keys was consumed and which are unrecognised.
 */
function pick(o: Obj, keys: string[], maxDepth = 2): { key: string; value: unknown } | null {
  const direct = pickShallow(o, keys);
  if (direct) return direct;
  if (maxDepth <= 0) return null;
  for (const [k, v] of Object.entries(o)) {
    if (!isObj(v)) continue;
    // Only small objects: a wrapper has a handful of keys, a payload blob has
    // dozens, and descending into the latter invites false positives.
    if (Object.keys(v).length > 8) continue;
    const inner = pick(v, keys, maxDepth - 1);
    if (inner) return { key: k, value: inner.value };
  }
  return null;
}

function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
  if (isObj(v)) {
    const inner = pick(v, CONTENT_KEYS);
    if (inner) return toText(inner.value);
    return '';
  }
  return '';
}

function normaliseRole(v: unknown): string {
  const raw = toText(v).trim().toLowerCase();
  if (!raw) return 'unknown';
  return ROLE_ALIASES[raw] ?? (raw === 'user' || raw === 'assistant' || raw === 'system' ? raw : raw.slice(0, 32));
}

/** Collects message-shaped objects from anywhere in the tree, depth-limited. */
function harvest(node: unknown, out: Obj[], depth = 0): void {
  if (depth > 8 || out.length > 20_000) return;
  if (Array.isArray(node)) {
    for (const n of node) harvest(n, out, depth + 1);
    return;
  }
  if (!isObj(node)) return;

  const role = pick(node, ROLE_KEYS);
  const content = pick(node, CONTENT_KEYS);
  if (role && content && toText(content.value).trim().length > 0) {
    out.push(node);
    // Do not descend into a message we already accepted: its content blocks
    // are part of this turn, not turns of their own.
    return;
  }
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

export function parseLoose(unit: RawUnit, text: string): UcfRunDraft[] {
  const docs: unknown[] = [];
  const trimmed = text.trim();
  try {
    docs.push(JSON.parse(trimmed));
  } catch {
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { docs.push(JSON.parse(l)); } catch { /* skip the unreadable line only */ }
    }
  }
  if (docs.length === 0) return [];

  const found: Obj[] = [];
  for (const d of docs) harvest(d, found);
  if (found.length === 0) return [];

  const turns: UcfTurn[] = [];
  const unknownKeys = new Set<string>();
  for (const m of found) {
    const roleHit = pick(m, ROLE_KEYS);
    const contentHit = pick(m, CONTENT_KEYS);
    const content = toText(contentHit?.value);
    if (content.trim().length === 0) continue;
    const timeHit = pick(m, TIME_KEYS);
    const parsedTime = timeHit ? parseLooseDate(timeHit.value) : null;

    const consumed = new Set([roleHit?.key, contentHit?.key, timeHit?.key].filter(Boolean) as string[]);
    const extra: Obj = {};
    for (const k of Object.keys(m)) {
      if (consumed.has(k)) continue;
      extra[k] = m[k];
      unknownKeys.add(k);
    }

    turns.push({
      idx: turns.length,
      role: normaliseRole(roleHit?.value),
      content,
      timestamp: parsedTime ? parsedTime.toISOString() : null,
      tool_calls: null,
      branch_id: null,
      parent_turn_ref: turns.length > 0 ? turns.length - 1 : null,
      truncated: false, tool_result: null, result_truncated: false,
      // Every unrecognised key survives: a backfill job can rescue this later,
      // a discarded key is gone forever (6.3 rule 1).
      raw_ext: extra,
    });
  }
  if (turns.length === 0) return [];

  const times = turns.map((t) => t.timestamp).filter((t): t is string => t != null).sort();
  return [{
    run_ref: unit.unitId,
    agent_ref: null,
    platform: 'unknown',
    model: null,
    started_at: times[0] ?? null,
    ended_at: times[times.length - 1] ?? null,
    outcome: null,
    title: null,
    binding_hints: [],
    turns,
    artifacts: [],
    parse_level: 'loose',
    adapter_id: 'l2_loose',
    adapter_version: '1',
    // The whole point of level 'loose': these are unreadable, not absent.
    degraded_fields: ['tool_calls', 'artifacts', 'outcome', 'platform']
      .concat(times.length === 0 ? ['turn_timestamps'] : []),
    absent_by_capability: [],
    raw_ext: {
      loose_parse: true,
      source_path: unit.path,
      unrecognised_keys: [...unknownKeys].sort().slice(0, 100),
    },
  }];
}
