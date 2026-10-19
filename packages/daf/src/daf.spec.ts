import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAF_LIMITS } from './limits.ts';
import { rejectedReport, summarizeReport, type DafValidationReport } from './report.ts';
import { coverageEnd, lookupFromBundle, resolveDaf, type ResolvedRun, type RunLookup } from './resolve.ts';
import { parseDaf, zDaf, type Daf } from './schema.ts';

const golden = JSON.parse(readFileSync(new URL('../fixtures/daf-v0.2.golden.json', import.meta.url), 'utf8')) as unknown;

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A run of 25 turns (idx 0..24) bound to agent A, as fn:analyze would hand it over. */
const run = (over: Partial<ResolvedRun> = {}): ResolvedRun => ({
  id: 'run-uuid-1', run_hash: HASH, run_ref: 'cc-session-0001', agent_id: 'agent-A', project_id: null,
  started_at: '2026-08-27T14:02:00+08:00', ended_at: '2026-08-27T16:45:00+08:00',
  turnIds: new Map(Array.from({ length: 25 }, (_, i) => [i, `turn-${i}`])),
  via: 'upload',
  ...over,
});
const lookupOne = (r: ResolvedRun): RunLookup => async (hash) => (hash === r.run_hash ? r : null);

describe('DAF v0.2 golden file (the contract the skill writes against)', () => {
  it('parses, with defaults filled', () => {
    const p = parseDaf(golden);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.daf.entries[1]!.rejected_options).toEqual([]);
    expect(p.daf.entries[1]!.entities).toEqual([]);
    expect(p.daf.agent_states[0]!.last_action?.summary).toContain('smoke test');
  });

  it('refuses a UUID-shaped anchor scheme: run_hash is a string, turn anchors are indices', () => {
    const bad = structuredClone(golden) as { entries: Record<string, unknown>[] };
    bad.entries[0]!.source_turn_idx = ['80000000-0000-4000-8000-000000000001'];
    const p = parseDaf(bad);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.issues[0]!.path).toBe('entries.0.source_turn_idx.0');
  });

  it('caps every string and every list at the documented limit', () => {
    const d = zDaf.parse(golden);
    const tooLong = { ...d, entries: [{ ...d.entries[0]!, body: 'x'.repeat(DAF_LIMITS.bodyMax + 1) }] };
    expect(zDaf.safeParse(tooLong).success).toBe(false);
    const tooMany = { ...d, entries: [{ ...d.entries[0]!, source_turn_idx: Array.from({ length: DAF_LIMITS.anchorsPerEntry + 1 }, (_, i) => i) }] };
    expect(zDaf.safeParse(tooMany).success).toBe(false);
  });

  it('a client cannot smuggle status, visibility or open: unknown keys are stripped', () => {
    const smuggled = structuredClone(golden) as { entries: Record<string, unknown>[] };
    smuggled.entries[0]!.status = 'confirmed';
    smuggled.entries[0]!.visibility = 'shared_link';
    smuggled.entries[0]!.open = true;
    const d = zDaf.parse(smuggled);
    expect('status' in d.entries[0]!).toBe(false);
    expect('visibility' in d.entries[0]!).toBe(false);
    expect('open' in d.entries[0]!).toBe(false);
  });

  it('rule 1 vs rule 6: a string over its cap refuses the DAF; a bad type or confidence is a per-item drop', async () => {
    const d = zDaf.parse(golden);                          // golden carries a type "opinion" with confidence 1.4 -- parses
    expect(d.entries.at(-1)!.type).toBe('opinion');
    const res = await resolveDaf(d, lookupOne(run()));
    expect(res.dropped.find((x) => x.index === 4)).toMatchObject({ kind: 'entry', reason: 'invalid_field' });
    const outOfRange = { ...d, entries: [{ ...d.entries[0]!, confidence: -0.1 }] };
    expect((await resolveDaf(outOfRange, lookupOne(run()))).dropped[0]).toMatchObject({ reason: 'invalid_field' });
  });
});

describe('resolver: the §18.5 gate, one item at a time, never the batch', () => {
  it('drops the entry with a fabricated anchor and the entry with an unknown run; keeps the rest', async () => {
    const daf = zDaf.parse(golden);
    const res = await resolveDaf(daf, lookupOne(run()));
    expect(res.entries.map((e) => e.entry.title)).toEqual(['Evaluation switched to LOPO', 'Re-run the baseline under LOPO']);
    expect(res.dropped).toEqual([
      { kind: 'entry', index: 2, run_hash: HASH, reason: 'anchor_unresolved', detail: [999] },
      { kind: 'entry', index: 3, run_hash: '0'.repeat(64), reason: 'run_unresolved' },
      { kind: 'entry', index: 4, run_hash: HASH, reason: 'invalid_field' },
    ]);
    // server ids come back in anchor order, and the covering segment is found
    expect(res.entries[0]!.turnIds).toEqual(['turn-12', 'turn-13', 'turn-14']);
    expect(res.entries[0]!.segmentIndex).toBe(0);
  });

  it('a segment whose range runs off the end of the run is dropped as range_unresolved', async () => {
    const daf: Daf = { ...zDaf.parse(golden), segments: [{ run_hash: HASH, run_ref: null, start_turn_idx: 20, end_turn_idx: 40, topic: null, summary: null, labels: [] }] };
    const res = await resolveDaf(daf, lookupOne(run()));
    expect(res.segments).toEqual([]);
    expect(res.dropped[0]).toMatchObject({ kind: 'segment', reason: 'range_unresolved', detail: [40] });
  });

  it('the agent comes from the resolved runs, not from agent_ref', async () => {
    const daf = zDaf.parse(golden);
    const res = await resolveDaf(daf, lookupOne(run({ agent_id: 'agent-Z' })));
    expect(res.agentStates[0]!.agentId).toBe('agent-Z');
  });

  it('a card over unbound runs is dropped; a card over two agents is ambiguous', async () => {
    const daf = zDaf.parse(golden);
    const unbound = await resolveDaf(daf, lookupOne(run({ agent_id: null })));
    expect(unbound.agentStates).toEqual([]);
    expect(unbound.dropped.at(-1)).toMatchObject({ kind: 'agent_state', reason: 'agent_unresolved' });

    const two: RunLookup = async (h) => (h === 'hash-one' ? run({ id: 'u1', run_hash: 'hash-one', agent_id: 'A' })
      : h === 'hash-two' ? run({ id: 'u2', run_hash: 'hash-two', agent_id: 'B' }) : null);
    const ambiguous = await resolveDaf({ ...daf, segments: [], entries: [], agent_states: [{ ...daf.agent_states[0]!, source_run_hashes: ['hash-one', 'hash-two'] }] }, two);
    expect(ambiguous.dropped[0]).toMatchObject({ kind: 'agent_state', reason: 'agent_ambiguous' });
  });

  it('caps are per run and total, and the overflow is counted rather than failing the batch', async () => {
    const daf = zDaf.parse(golden);
    const one = daf.entries[0]!;
    const many = { ...daf, entries: Array.from({ length: DAF_LIMITS.entriesPerRun + 5 }, () => ({ ...one })) };
    const res = await resolveDaf(many, lookupOne(run()));
    expect(res.entries.length).toBe(DAF_LIMITS.entriesPerRun);
    expect(res.dropped.filter((d) => d.reason === 'over_cap').length).toBe(5);
  });

  it('records which runs were found only through the workspace (the dedupe case)', async () => {
    const daf = zDaf.parse(golden);
    const res = await resolveDaf(daf, lookupOne(run({ via: 'workspace' })));
    expect(res.runsResolvedViaWorkspace).toEqual([HASH]);
  });

  it('coverage end is the latest instant any source run reaches, whatever the offsets', () => {
    expect(coverageEnd([run({ ended_at: null, started_at: '2026-01-01T00:00:00Z' }), run({ ended_at: '2026-02-01T00:00:00Z' })]))
      .toBe('2026-02-01T00:00:00Z');
    // "+08:00" sorts after "Z" as a string; as an instant it is earlier.
    expect(coverageEnd([run({ ended_at: '2026-02-01T07:00:00+08:00' }), run({ ended_at: '2026-02-01T00:00:00Z' })]))
      .toBe('2026-02-01T00:00:00Z');
  });

  it('the bundle-backed lookup applies the same rules locally', async () => {
    const daf = zDaf.parse(golden);
    const lookup = lookupFromBundle([{ run_hash: HASH, run_ref: 'cc-session-0001', agent_ref: 'agent:b1', started_at: null, ended_at: null, turns: Array.from({ length: 25 }, (_, idx) => ({ idx })) }]);
    const res = await resolveDaf(daf, lookup);
    expect(res.entries.length).toBe(2);
    expect(res.dropped.map((d) => d.reason)).toEqual(['anchor_unresolved', 'run_unresolved', 'invalid_field']);
  });
});

describe('report', () => {
  it('a rejected report is all zeros and names the reason', () => {
    const r = rejectedReport(zDaf.parse(golden).analyzer, 'schema', [{ path: 'entries.0.type', message: 'bad' }]);
    expect(r.outcome).toBe('rejected');
    expect(r.counts.entries.written).toBe(0);
    expect(summarizeReport(r)).toContain('did not match the DAF schema');
  });

  it('the one-line summary counts what landed and what did not', () => {
    const r: DafValidationReport = {
      ...rejectedReport(zDaf.parse(golden).analyzer, 'schema'),
      outcome: 'accepted', rejected_reason: undefined, daf_ref: 'ws/b/daf/x.json',
      counts: { segments: { received: 1, written: 1, dropped: 0 }, entries: { received: 4, written: 2, dropped: 2 }, agent_states: { received: 1, written: 1, dropped: 0 } },
      dropped: [
        { kind: 'entry', index: 2, run_hash: 'r', reason: 'anchor_unresolved' },
        { kind: 'entry', index: 3, run_hash: 'r', reason: 'run_unresolved' },
      ],
    };
    expect(summarizeReport(r)).toBe('2 entries, 1 segment, 1 state card filed as pending; 2 dropped (2 with anchors that did not resolve)');
  });
});
