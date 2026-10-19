import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { keepBundle, packBundle } from '@distill/capture';
import { CQS_VERSION } from '@distill/capture';
import { uuid, type BundleMeta, type CaptureReport } from '@distill/shared';
import type { UcfRun } from '@distill/ucf';

/**
 * `actario analyze`, end to end at the process boundary, against a bundle in
 * a throwaway ACTARIO_HOME and no API (the one thing that cannot be faked in
 * a unit test is the network, so the cases stop where the network starts:
 * exit 3, "not linked", with the DAF already validated).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/actario.js');

let home: string;
let stateHome: string;
let bundleId: string;
const uploadId = uuid();

/**
 * The anchor coordinate (v0.2): runs.content_hash, which `actario capture`
 * writes into raw_ext and the server deduplicates on. run_ref is NOT it --
 * Claude Code puts one session id on every run it split out of that session.
 */
const HASH1 = `11${'1'.repeat(62)}`;
const HASH2 = `22${'2'.repeat(62)}`;

const run = (ref: string, hash: string, turns: number, title: string): UcfRun => ({
  run_ref: ref, agent_ref: 'agent:b1', platform: 'claude_code', model: 'claude-sonnet-4-5',
  started_at: '2026-08-27T14:02:00+08:00', ended_at: '2026-08-27T16:45:00+08:00', outcome: 'completed', title, binding_hints: [],
  turns: Array.from({ length: turns }, (_, idx) => ({
    idx, role: idx % 2 ? 'assistant' : 'user', content: `turn ${idx} of ${ref}`, timestamp: null,
    tool_calls: idx === 2 ? [{ name: 'Read', params: { file_path: 'a.ts', big: 'x'.repeat(1000) }, ok: true, raw_ext: {} }] : null,
    branch_id: null, parent_turn_ref: null, truncated: false,
    tool_result: idx === 2 ? 'y'.repeat(5000) : null, result_truncated: false, raw_ext: {},
  })),
  artifacts: [{ path: 'clean_v3.py', change: 'modified', diff_summary: '+12 -3', diff_body: null, sha256: null, raw_ext: {} }],
  parse_level: 'strict', adapter_id: 'claude_code_session', adapter_version: '1',
  degraded_fields: [], absent_by_capability: [], raw_ext: { content_hash: hash },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'distill-analyze-'));
  stateHome = join(home, '.actario');
  mkdirSync(stateHome, { recursive: true });
  process.env.ACTARIO_HOME = stateHome;

  const bundleMeta: BundleMeta = {
    bundle_id: uuid(), ucf_version: '0.2', cli_version: '0.1.0-test', created_at: new Date().toISOString(),
    host_os: 'linux', redaction_profile: 'general', hard_rules_enforced: true,
  };
  bundleId = bundleMeta.bundle_id;
  const report: CaptureReport = {
    cqs: 90, cqs_version: CQS_VERSION, runs_total: 2, runs_kept: 2, runs_dropped: 0,
    parse_levels: { strict: 2, loose: 0, raw: 0 },
    coverage_start: null, coverage_end: null, coverage_gap_pct: 0, truncation_pct: 0, result_truncated_pct: 0,
    tool_calls_total: 2, artifacts_total: 2, runs_with_tool_calls: 2, runs_with_artifacts: 2,
    degraded_fields: [], absent_by_capability: [], redactions: {}, warnings: [], adapters: [],
  };
  const pack = await packBundle({
    outDir: mkdtempSync(join(tmpdir(), 'distill-pack-')), bundleMeta, captureReport: report, agents: [],
    runs: [run('run:cc-1', HASH1, 6, 'rewrite the clean pipeline'), run('run:cc-2', HASH2, 4, 'eval split')], droppedRuns: [],
  });
  keepBundle(pack.bundleDir, { bundle_id: bundleId, upload_id: uploadId, runs: 2 });
});

function cli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', BIN, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: stateHome, HOME: home, USERPROFILE: home, ACTARIO_API_URL: '', ACTARIO_TOKEN: '' },
  });
}

describe('actario analyze -- prepare', () => {
  it('writes the runs as readable JSON and says where the DAF goes', () => {
    const r = cli(['analyze']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Analyze bundle ${bundleId}`);
    expect(r.stdout).toContain(HASH1.slice(0, 16));        // the table shows the anchor, not run_ref
    expect(r.stdout).toContain('--daf');

    const dir = join(stateHome, 'analysis', bundleId);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { runs: { file: string; run_hash: string; run_ref: string; turns: number }[]; upload_id: string };
    expect(index.upload_id).toBe(uploadId);
    expect(index.runs.map((x) => `${x.run_ref}:${x.turns}`)).toEqual(['run:cc-1:6', 'run:cc-2:4']);
    // the anchor coordinate is run_hash, not run_ref (v0.2, arch v1.3 18.4)
    expect(index.runs.map((x) => x.run_hash)).toEqual([HASH1, HASH2]);

    const first = JSON.parse(readFileSync(join(dir, index.runs[0]!.file), 'utf8')) as { turns: { idx: number; tool_result?: string; tool_calls?: { params: { big: string } }[] }[] };
    expect(first.turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    // long evidence is capped, the conversation is not
    expect(first.turns[2]!.tool_result!.length).toBeLessThan(2100);
    expect(first.turns[2]!.tool_calls![0]!.params.big).toContain('[1000 chars]');

    const template = JSON.parse(readFileSync(join(dir, 'daf.template.json'), 'utf8')) as { bundle_id: string; daf_version: string };
    expect(template.bundle_id).toBe(bundleId);
    expect(template.daf_version).toBe('0.2');
  });

  it('--json prints the index for an agent to parse', () => {
    const r = cli(['analyze', '--json']);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { bundle_id: string }).bundle_id).toBe(bundleId);
  });

  it('--bundle with a prefix of the upload id finds the local bundle', () => {
    const r = cli(['analyze', '--bundle', uploadId.slice(0, 8), '--json']);
    expect(r.status, r.stderr).toBe(0);
  });

  it('an unknown short id is a plain "not found", never a network call', () => {
    const r = cli(['analyze', '--bundle', 'deadbeef']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Not found locally');
  });
});

describe('actario analyze -- submit', () => {
  const dafDir = () => join(stateHome, 'analysis', bundleId);
  const write = (name: string, daf: unknown) => {
    mkdirSync(dafDir(), { recursive: true });
    const p = join(dafDir(), name);
    writeFileSync(p, JSON.stringify(daf));
    return p;
  };
  const good = () => ({
    daf_version: '0.2', bundle_id: bundleId,
    analyzer: { kind: 'agent_session', model: 'test', skill_version: '1', prompt_version: 'test@1', produced_at: new Date().toISOString() },
    segments: [{ run_hash: HASH1, start_turn_idx: 0, end_turn_idx: 5, topic: 'pipeline' }],
    entries: [
      { type: 'decision', title: 'Streaming writer replaces buffering', body: 'because memory', confidence: 0.8, run_hash: HASH1, source_turn_idx: [2, 3] },
      { type: 'fact', title: 'A fabricated anchor', body: 'idx 99 does not exist', confidence: 0.9, run_hash: HASH1, source_turn_idx: [99] },
    ],
    agent_states: [{ doing_now: 'rewrite done', confidence: 'high', source_run_hashes: [HASH1, HASH2] }],
  });

  it('a DAF that fails the schema is refused locally with the paths, exit 2', () => {
    // A missing body is a shape error (rule 1: whole file refused). A bad
    // `type` is deliberately NOT one -- that is a per-item drop (rule 6).
    const p = write('bad.json', { ...good(), entries: [{ type: 'decision', title: 'x' }] });
    const r = cli(['analyze', '--daf', p]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('schema v0.2');
    expect(r.stderr).toContain('entries.0.body');
  });

  it('a DAF for another bundle is refused as a mismatch', () => {
    const p = write('other.json', { ...good(), bundle_id: uuid() });
    const r = cli(['analyze', '--daf', p]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Bundle mismatch');
  });

  it('a valid DAF is checked against the bundle, the bad anchor is named, and it stops at "not linked" (3)', () => {
    const p = write('good.json', good());
    const r = cli(['analyze', '--daf', p]);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stdout).toContain('2 entries, 1 segments, 1 state cards');
    expect(r.stdout).toContain('will be dropped');
    expect(r.stdout).toContain(`turn idx 99 not in run ${HASH1.slice(0, 16)}`);
    expect(r.stderr).toContain('Not linked');
  });

  it('when every anchor is wrong nothing is sent (2), unless --force', () => {
    const daf = good();
    daf.entries = [daf.entries[1]!];
    daf.segments = []; daf.agent_states = [];
    const p = write('allbad.json', daf);
    const r = cli(['analyze', '--daf', p]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Every item would be dropped');
    const forced = cli(['analyze', '--daf', p, '--force']);
    expect(forced.status).toBe(3);        // past the local gate, stopped by no API
  });

  it('a bundle_id missing from a hand-written DAF is filled from the selected bundle', () => {
    const { bundle_id: _omit, ...withoutId } = good();
    void _omit;
    const p = write('noid.json', withoutId);
    const r = cli(['analyze', '--daf', p]);
    expect(r.status, r.stderr).toBe(3);
    expect(existsSync(p)).toBe(true);
  });
});
