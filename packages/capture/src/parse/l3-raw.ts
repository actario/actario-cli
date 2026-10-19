import { parseLooseDate } from '@distill/shared';
import type { RawUnit } from '@distill/adapters';
import type { UcfRunDraft } from '@distill/ucf';

/**
 * L3: plain-text floor (6.3).
 *
 * Reached when not even a role/content pair could be found. The whole file
 * becomes one turn with role 'unknown'. It is searchable and it is archived;
 * it does not feed state summaries, because there is no way to tell who said
 * what.
 *
 * This level is what makes "the batch never fails" literally true rather than
 * nearly true, and it costs about thirty lines.
 */

const MAX_CHARS = 400_000; // ~400 KB of text per raw turn; beyond this we truncate

export function parseRaw(unit: RawUnit, text: string): UcfRunDraft[] {
  const body = text.trim();
  if (body.length === 0) return [];

  const truncated = body.length > MAX_CHARS;
  const content = truncated ? `${body.slice(0, MAX_CHARS)}\n...[truncated by capture]` : body;
  const mtime = parseLooseDate(unit.mtime);

  return [{
    run_ref: unit.unitId,
    agent_ref: null,
    platform: 'unknown',
    model: null,
    started_at: mtime ? mtime.toISOString() : null,
    ended_at: mtime ? mtime.toISOString() : null,
    outcome: null,
    title: unit.path.split(/[\\/]/).pop() ?? null,
    binding_hints: [],
    turns: [{
      idx: 0,
      role: 'unknown',
      content,
      timestamp: mtime ? mtime.toISOString() : null,
      tool_calls: null,
      branch_id: null,
      parent_turn_ref: null,
      truncated,
      raw_ext: {},
    }],
    artifacts: [],
    parse_level: 'raw',
    adapter_id: 'l3_raw',
    adapter_version: '1',
    degraded_fields: ['role', 'tool_calls', 'artifacts', 'outcome', 'platform', 'turn_timestamps'],
    absent_by_capability: [],
    raw_ext: { raw_parse: true, source_path: unit.path, bytes: unit.bytes },
  }];
}
