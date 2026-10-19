import { existsSync, mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuid, type BundleMeta, type CaptureReport } from '@distill/shared';
import type { UcfRun } from '@distill/ucf';
import { KEEP_BUNDLES, bundleDirFor, findBundle, keepBundle, latestBundle, readBundleIndex, readBundleRuns, recordBundle } from './bundles.ts';
import { CQS_VERSION } from './cqs-weights.ts';
import { packBundle } from './pack.ts';

/**
 * The local bundle store (arch v1.3 18.7): what `actario analyze` reads.
 * ACTARIO_HOME is pointed at a temp dir per test so nothing touches ~/.actario.
 */
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'distill-bundles-'));
  prevHome = process.env.ACTARIO_HOME;
  process.env.ACTARIO_HOME = join(home, '.actario');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.ACTARIO_HOME; else process.env.ACTARIO_HOME = prevHome;
});

const meta = (): BundleMeta => ({
  bundle_id: uuid(), ucf_version: '0.2', cli_version: '0.1.0-test', created_at: new Date().toISOString(),
  host_os: 'linux', redaction_profile: 'general', hard_rules_enforced: true,
});
const report: CaptureReport = {
  cqs: 92, cqs_version: CQS_VERSION, runs_total: 2, runs_kept: 2, runs_dropped: 0,
  parse_levels: { strict: 2, loose: 0, raw: 0 },
  coverage_start: null, coverage_end: null, coverage_gap_pct: 0, truncation_pct: 0, result_truncated_pct: 0,
  tool_calls_total: 0, artifacts_total: 0, runs_with_tool_calls: 0, runs_with_artifacts: 0,
  degraded_fields: [], absent_by_capability: [], redactions: {}, warnings: [], adapters: [],
};
const run = (ref: string, turns: number): UcfRun => ({
  run_ref: ref, agent_ref: null, platform: 'claude_code', model: null,
  started_at: null, ended_at: null, outcome: null, title: null, binding_hints: [],
  turns: Array.from({ length: turns }, (_, idx) => ({
    idx, role: idx % 2 ? 'assistant' : 'user', content: `t${idx}`, timestamp: null, tool_calls: null,
    branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {},
  })),
  artifacts: [], parse_level: 'strict', adapter_id: 'a', adapter_version: '1',
  degraded_fields: [], absent_by_capability: [], raw_ext: {},
});

async function packed(bundleMeta = meta()) {
  const out = await mkdtemp(join(tmpdir(), 'distill-pack-'));
  const pack = await packBundle({ outDir: out, bundleMeta, captureReport: report, agents: [], runs: [run('run:a', 3), run('run:b', 5)], droppedRuns: [] });
  return { pack, bundleMeta };
}

describe('the local bundle store', () => {
  it('keeps a packed bundle under its bundle_id and indexes it newest first', async () => {
    const { pack, bundleMeta } = await packed();
    const uploadId = uuid();
    const dest = keepBundle(pack.bundleDir, { bundle_id: bundleMeta.bundle_id, upload_id: uploadId, runs: 2 });
    expect(dest).toBe(bundleDirFor(bundleMeta.bundle_id));
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true);
    expect(existsSync(pack.bundleDir)).toBe(false);          // moved, not copied
    expect(latestBundle()?.upload_id).toBe(uploadId);
    expect(findBundle(uploadId.slice(0, 8))?.toString()).not.toBe('ambiguous');
    expect((findBundle(bundleMeta.bundle_id) as { origin: string }).origin).toBe('capture');
  });

  it('streams the runs back out, in manifest order', async () => {
    const { pack, bundleMeta } = await packed();
    keepBundle(pack.bundleDir, { bundle_id: bundleMeta.bundle_id, upload_id: null, runs: 2 });
    const refs: string[] = [];
    for await (const r of readBundleRuns(bundleDirFor(bundleMeta.bundle_id))) if (r.ok) refs.push(`${r.run.run_ref}:${r.run.turns.length}`);
    expect(refs).toEqual(['run:a:3', 'run:b:5']);
  });

  it('prunes to the newest KEEP_BUNDLES, deleting the old directories', async () => {
    for (let i = 0; i < KEEP_BUNDLES + 2; i++) {
      const { pack, bundleMeta } = await packed();
      keepBundle(pack.bundleDir, { bundle_id: bundleMeta.bundle_id, upload_id: null, runs: 2, captured_at: new Date(2026, 0, i + 1).toISOString() });
    }
    const idx = readBundleIndex();
    expect(idx.length).toBe(KEEP_BUNDLES);
    // the two oldest are gone from disk as well as from the index
    expect(idx.every((b) => existsSync(bundleDirFor(b.bundle_id)))).toBe(true);
  });

  it('findBundle: prefix of bundle or upload id; ambiguous when two match', () => {
    const a = { bundle_id: '11111111-1111-4111-8111-111111111111', upload_id: '22222222-2222-4222-8222-222222222222', runs: 1, captured_at: '2026-01-02T00:00:00Z', origin: 'capture' as const };
    const b = { bundle_id: '11111111-aaaa-4111-8111-111111111111', upload_id: null, runs: 1, captured_at: '2026-01-01T00:00:00Z', origin: 'export' as const };
    recordBundle(a); recordBundle(b);
    expect(findBundle('2222')).toEqual(a);
    expect(findBundle('11111111-aaaa')).toEqual(b);
    expect(findBundle('11111111')).toBe('ambiguous');
    expect(findBundle(a.bundle_id)).toEqual(a);            // exact id wins over prefix ambiguity
    expect(findBundle('zzz')).toBeNull();
  });
});
