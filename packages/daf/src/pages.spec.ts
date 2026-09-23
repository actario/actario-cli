import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAF_LIMITS } from './limits.ts';
import { rejectedReport, summarizeReport } from './report.ts';
import { lookupFromBundle, resolveDaf, type ResolvedRun, type RunLookup } from './resolve.ts';
import { parseDaf, zDaf, type DafInput } from './schema.ts';

/**
 * Note pages (design 0002): additive to v0.2, one per run, every section's
 * range must be real turns of that run or the page does not land.
 */
const golden = JSON.parse(readFileSync(new URL('../fixtures/daf-v0.2.golden.json', import.meta.url), 'utf8')) as DafInput;
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const run: ResolvedRun = {
  id: 'run-uuid-1', run_hash: HASH, run_ref: null, agent_id: 'agent-A', project_id: null,
  started_at: '2026-08-27T14:02:00+08:00', ended_at: null,
  turnIds: new Map(Array.from({ length: 25 }, (_, i) => [i, `turn-${i}`])), via: 'upload',
};
const lookup: RunLookup = async (h) => (h === HASH ? run : null);

const page = (over: Record<string, unknown> = {}) => ({
  run_hash: HASH, title: '把 LOPO 換成評估方式',
  summary: '從隨機切分改成 LOPO，基線重跑仍未完成。',
  sections: [
    { heading: '背景', start_turn_idx: 0, end_turn_idx: 4, body: '原本用 **隨機切分**。' },
    { heading: '決定與理由', start_turn_idx: 5, end_turn_idx: 12, body: '| 選項 | 結果 |\n|---|---|\n| LOPO | 採用 |' },
  ],
  ...over,
});
const withPages = (pages: unknown[]) => ({ ...golden, segments: [], entries: [], agent_states: [], pages });

describe('DAF pages: schema', () => {
  it('a DAF without pages still parses, and pages defaults to []', () => {
    const p = parseDaf(golden);
    expect(p.ok && p.daf.pages).toEqual([]);
  });

  it('parses a page with defaults filled', () => {
    const p = parseDaf(withPages([page({ summary: undefined })]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.daf.pages[0]).toMatchObject({ run_ref: null, summary: null, labels: [] });
  });

  it('refuses the whole DAF on a section over its cap, an empty page, or a reversed range', () => {
    const long = page({ sections: [{ heading: 'x', start_turn_idx: 0, end_turn_idx: 1, body: 'y'.repeat(DAF_LIMITS.sectionBodyMax + 1) }] });
    expect(parseDaf(withPages([long])).ok).toBe(false);
    expect(parseDaf(withPages([page({ sections: [] })])).ok).toBe(false);
    // A heading of spaces is empty once trimmed -- caught here, not inside the gate.
    expect(parseDaf(withPages([page({ sections: [{ heading: '   ', start_turn_idx: 0, end_turn_idx: 1, body: 'y' }] })])).ok).toBe(false);
    const reversed = parseDaf(withPages([page({ sections: [{ heading: 'x', start_turn_idx: 5, end_turn_idx: 2, body: 'y' }] })]));
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.issues[0]!.path).toBe('pages.0.sections.0.end_turn_idx');
    const tooMany = page({ sections: Array.from({ length: DAF_LIMITS.sectionsPerPage + 1 }, () => ({ heading: 'h', start_turn_idx: 0, end_turn_idx: 0, body: 'b' })) });
    expect(zDaf.safeParse(withPages([tooMany])).success).toBe(false);
  });
});

describe('DAF pages: resolver', () => {
  it('keeps a page whose every range resolves', async () => {
    const res = await resolveDaf(zDaf.parse(withPages([page()])), lookup);
    expect(res.pages).toHaveLength(1);
    expect(res.pages[0]!.run.id).toBe('run-uuid-1');
    expect(res.dropped).toEqual([]);
  });

  it('drops the whole page when one section points past the run, and says which indices', async () => {
    const bad = page({ sections: [...page().sections, { heading: '未決', start_turn_idx: 20, end_turn_idx: 99, body: 'x' }] });
    const res = await resolveDaf(zDaf.parse(withPages([bad])), lookup);
    expect(res.pages).toEqual([]);
    expect(res.dropped).toEqual([{ kind: 'page', index: 0, run_hash: HASH, reason: 'range_unresolved', detail: [99] }]);
  });

  it('drops a page for an unknown run, and a second page for the same run', async () => {
    const res = await resolveDaf(zDaf.parse(withPages([page(), page({ title: 'again' }), page({ run_hash: '0'.repeat(64) })])), lookup);
    expect(res.pages.map((p) => p.page.title)).toEqual(['把 LOPO 換成評估方式']);
    expect(res.dropped.map((d) => [d.index, d.reason])).toEqual([[1, 'over_cap'], [2, 'run_unresolved']]);
  });

  it('the local pre-check drops exactly what the server would', async () => {
    const local = lookupFromBundle([{ run_hash: HASH, run_ref: null, turns: Array.from({ length: 13 }, (_, idx) => ({ idx })), started_at: null, ended_at: null, agent_ref: null }]);
    const bad = page({ sections: [{ heading: 'x', start_turn_idx: 10, end_turn_idx: 13, body: 'y' }] });
    const res = await resolveDaf(zDaf.parse(withPages([page(), bad])), local);
    expect(res.pages).toHaveLength(1);
    expect(res.dropped).toEqual([{ kind: 'page', index: 1, run_hash: HASH, reason: 'range_unresolved', detail: [13] }]);
  });
});

describe('DAF pages: report', () => {
  it('counts pages in the one-line summary only when there were any', () => {
    const base = rejectedReport(zDaf.parse(golden).analyzer, 'schema');
    const zero = { received: 0, written: 0, dropped: 0 };
    const accepted = { ...base, outcome: 'accepted' as const, counts: { segments: { received: 2, written: 2, dropped: 0 }, entries: zero, agent_states: zero } };
    expect(summarizeReport(accepted)).not.toContain('note page');
    expect(summarizeReport({ ...accepted, counts: { ...accepted.counts, pages: { received: 2, written: 1, dropped: 1 } } }))
      .toMatch(/1 note page filed as pending; 1 dropped/);
  });
});
