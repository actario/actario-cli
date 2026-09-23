import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256, uuid } from '@distill/shared';
import type { BundleMeta, CaptureReport } from '@distill/shared';
import { parseRunLine } from '@distill/ucf';
import { packBundle, readManifest } from './pack.ts';
import { CQS_VERSION } from './cqs-weights.ts';

const meta = (): BundleMeta => ({
  bundle_id: uuid(),
  ucf_version: '0.2',
  cli_version: '0.1.0-test',
  created_at: new Date().toISOString(),
  host_os: 'linux',
  redaction_profile: 'general',
  hard_rules_enforced: true,
});

const report: CaptureReport = {
  cqs: 92, cqs_version: CQS_VERSION, runs_total: 3, runs_kept: 3, runs_dropped: 0,
  parse_levels: { strict: 3, loose: 0, raw: 0 },
  coverage_start: null, coverage_end: null, coverage_gap_pct: 0, truncation_pct: 0, result_truncated_pct: 0,
  tool_calls_total: 0, artifacts_total: 0, runs_with_tool_calls: 0, runs_with_artifacts: 0,
  degraded_fields: [], absent_by_capability: [], redactions: {}, warnings: [], adapters: [],
};

const runs = Array.from({ length: 3 }, (_, i) => ({
  run_ref: `r${i}`, agent_ref: null, platform: 'claude_code', model: null,
  started_at: null, ended_at: null, outcome: null, title: null, binding_hints: [],
  turns: [{
    idx: 0, role: 'user', content: `turn ${i}`, timestamp: null, tool_calls: null,
    branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {},
  }],
  artifacts: [], parse_level: 'strict' as const, adapter_id: 'a', adapter_version: '1',
  degraded_fields: [], absent_by_capability: [], raw_ext: {},
}));

async function readGzLines(path: string): Promise<string[]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).pipe(createGunzip())
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', resolve)
      .on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
}

describe('bundle packing (7.1)', () => {
  it('writes split NDJSON, agents.json and a manifest with per-file hashes', async () => {
    const out = await mkdtemp(join(tmpdir(), 'distill-pack-'));
    const res = await packBundle({
      outDir: out, bundleMeta: meta(), captureReport: report,
      agents: [], runs, droppedRuns: [],
    });

    expect(res.files.map((f) => f.name)).toEqual(['agents.json', 'runs/000001.ndjson.gz']);

    // Every declared hash must match the object on disk: /complete verifies
    // exactly this, so a wrong hash here would be a 409 in production (7.2).
    for (const f of res.files) {
      const buf = await readFile(join(res.bundleDir, f.name));
      expect(sha256(buf)).toBe(f.sha256);
      expect((await stat(join(res.bundleDir, f.name))).size).toBe(f.bytes);
    }

    const manifest = await readManifest(res.bundleDir);
    expect(manifest.capture_report.cqs).toBe(92);
    // manifest.json is the declaration, so it is not itself a declared file.
    expect(manifest.files.some((f) => f.name === 'manifest.json')).toBe(false);
  });

  it('every line is one independently parseable run', async () => {
    const out = await mkdtemp(join(tmpdir(), 'distill-pack-'));
    const res = await packBundle({
      outDir: out, bundleMeta: meta(), captureReport: report,
      agents: [], runs, droppedRuns: [],
    });
    const lines = await readGzLines(join(res.bundleDir, 'runs/000001.ndjson.gz'));
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(parseRunLine(l).ok).toBe(true);
  });

  it('rotates parts so one file can be retried on its own', async () => {
    const out = await mkdtemp(join(tmpdir(), 'distill-pack-'));
    // Incompressible content, so the compressed-size rotation actually trips.
    const big = Array.from({ length: 40 }, (_, i) => ({
      ...runs[0]!,
      run_ref: `big${i}`,
      turns: [{
        ...runs[0]!.turns[0]!,
        content: Array.from({ length: 4000 }, () => Math.random().toString(36).slice(2)).join(' '),
      }],
    }));
    const res = await packBundle({
      outDir: out, bundleMeta: meta(), captureReport: report,
      agents: [], runs: big, droppedRuns: [],
      // Small cap so the test does not have to produce 32 MB.
      maxPartBytes: 64 * 1024,
    });
    expect(res.files.length).toBeGreaterThanOrEqual(2);
  });

  it('records dropped runs in the manifest so the UI can list them (C5)', async () => {
    const out = await mkdtemp(join(tmpdir(), 'distill-pack-'));
    const res = await packBundle({
      outDir: out, bundleMeta: meta(), captureReport: report, agents: [], runs,
      droppedRuns: [{ run_ref: 'busted', reason: 'required_field_missing: turns too_small' }],
    });
    const manifest = await readManifest(res.bundleDir);
    expect(manifest.dropped_runs).toHaveLength(1);
    expect(manifest.dropped_runs[0]!.run_ref).toBe('busted');
  });
});
