import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { summarizeReport, type DafValidationReport } from './report.ts';
import { resolveDaf, type ResolvedRun, type RunLookup } from './resolve.ts';
import { parseDaf, type DafInput } from './schema.ts';

/** run_meta (2026-10-18, arch 28.2): tags, facets and a line hint per run; additive to v0.2. */
const golden = JSON.parse(readFileSync(new URL('../fixtures/daf-v0.2.golden.json', import.meta.url), 'utf8')) as DafInput;
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const run: ResolvedRun = {
  id: 'run-uuid-1', run_hash: HASH, run_ref: null, agent_id: null, project_id: null,
  started_at: '2026-10-18T10:00:00+08:00', ended_at: null, turnIds: new Map([[0, 't0']]), via: 'upload',
};
const lookup: RunLookup = async (h) => (h === HASH ? run : null);
const withMeta = (run_meta: unknown[]) => ({ ...golden, segments: [], entries: [], agent_states: [], pages: [], run_meta });

describe('DAF run_meta: schema', () => {
  it('absent means []; defaults fill facets and the hint', () => {
    const p = parseDaf(golden);
    expect(p.ok && p.daf.run_meta).toEqual([]);
    const q = parseDaf(withMeta([{ run_hash: HASH, tags: ['京都旅行'] }]));
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.daf.run_meta[0]).toEqual({ run_hash: HASH, run_ref: null, tags: ['京都旅行'], facets: { category: null, task_type: null, outputs: [], scope: null }, line_hint: null });
  });

  it('facets are a closed set; tags and names have caps; a hint id is a uuid', () => {
    expect(parseDaf(withMeta([{ run_hash: HASH, facets: { category: 'hobby' } }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, facets: { outputs: ['video'] } }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, tags: ['x'.repeat(65)] }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, line_hint: { agent_id: 'not-a-uuid' } }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, line_hint: { new_name: 'x'.repeat(41) } }])).ok).toBe(false);
    expect(parseDaf(withMeta([{ run_hash: HASH, facets: { category: 'life', task_type: 'planning', outputs: ['doc'], scope: 'topic' }, line_hint: { new_name: '京都旅行' } }])).ok).toBe(true);
  });
});

describe('DAF run_meta: resolver', () => {
  it('keeps one per resolvable run; drops an unknown run and a second for the same run', async () => {
    const p = parseDaf(withMeta([{ run_hash: HASH, tags: ['a1'] }, { run_hash: 'f'.repeat(64), tags: ['b1'] }, { run_hash: HASH, tags: ['c1'] }]));
    if (!p.ok) throw new Error('parse');
    const r = await resolveDaf(p.daf, lookup);
    expect(r.runMeta.map((m) => [m.index, m.meta.tags])).toEqual([[0, ['a1']]]);
    expect(r.dropped).toEqual([
      { kind: 'run_meta', index: 1, run_hash: 'f'.repeat(64), reason: 'run_unresolved' },
      { kind: 'run_meta', index: 2, run_hash: HASH, reason: 'over_cap' },
    ]);
  });

  it('the summary line counts runs that got tags', () => {
    const zero = { received: 0, written: 0, dropped: 0 };
    const report = { outcome: 'accepted', counts: { segments: zero, entries: zero, agent_states: zero, run_meta: { received: 2, written: 2, dropped: 0 } }, dropped: [] } as unknown as DafValidationReport;
    expect(summarizeReport(report)).toContain('tags on 2 runs');
  });
});
