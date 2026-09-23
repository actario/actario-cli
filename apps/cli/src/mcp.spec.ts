import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keepBundle, packBundle, CQS_VERSION } from '@distill/capture';
import { uuid, type BundleMeta, type CaptureReport } from '@distill/shared';
import type { UcfRun } from '@distill/ucf';

/**
 * `actario mcp`, end to end at the process boundary: a real MCP client over
 * a real stdio transport against the real server, with a bundle in a
 * throwaway ACTARIO_HOME and no API.
 *
 * The transport is the point of the first case. Everything the CLI's flows
 * log goes to stdout by default, and one stray line there is a malformed
 * JSON-RPC frame; the server redirects logging before it connects, and the
 * only way to know that worked is to run the wire.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/actario.js');

const HASH1 = `11${'1'.repeat(62)}`;
const HASH2 = `22${'2'.repeat(62)}`;
/** Shares its first 32 characters with HASH1: the ambiguity case. */
const HASH3 = `${'1'.repeat(32)}${'3'.repeat(32)}`;

let home: string;
let stateHome: string;
let bundleId: string;
let client: Client;
const uploadId = uuid();

const run = (ref: string, hash: string, turns: number, title: string): UcfRun => ({
  run_ref: ref, agent_ref: 'agent:b1', platform: 'claude_code', model: 'claude-sonnet-4-5',
  started_at: '2026-08-27T14:02:00+08:00', ended_at: '2026-08-27T16:45:00+08:00', outcome: 'completed', title, binding_hints: [],
  turns: Array.from({ length: turns }, (_, idx) => ({
    idx, role: idx % 2 ? 'assistant' : 'user', content: `turn ${idx} of ${ref}`, timestamp: null,
    tool_calls: null, branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {},
  })),
  artifacts: [], parse_level: 'strict', adapter_id: 'claude_code_session', adapter_version: '1',
  degraded_fields: [], absent_by_capability: [], raw_ext: { content_hash: hash },
});

// callTool's result type is a union (content-bearing or legacy toolResult);
// every tool here returns one text block, so read it as that.
const text = (r: unknown): unknown => {
  const c = ((r as { content: { type: string; text: string }[] }).content)[0]!;
  return JSON.parse(c.text);
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'distill-mcp-'));
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
    tool_calls_total: 0, artifacts_total: 0, runs_with_tool_calls: 0, runs_with_artifacts: 0,
    degraded_fields: [], absent_by_capability: [], redactions: {}, warnings: [], adapters: [],
  };
  const pack = await packBundle({
    outDir: mkdtempSync(join(tmpdir(), 'distill-pack-')), bundleMeta, captureReport: report, agents: [],
    runs: [run('run:cc-1', HASH1, 6, 'rewrite the clean pipeline'), run('run:cc-2', HASH2, 4, 'eval split'), run('run:cc-3', HASH3, 3, 'lookalike')], droppedRuns: [],
  });
  keepBundle(pack.bundleDir, { bundle_id: bundleId, upload_id: uploadId, runs: 3 });

  client = new Client({ name: 'mcp-spec', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', BIN, 'mcp'],
    env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: stateHome, HOME: home, USERPROFILE: home, ACTARIO_API_URL: '', ACTARIO_TOKEN: '', ACTARIO_SOURCE_ID: '' } as Record<string, string>,
    stderr: 'pipe',
  }));
}, 30_000);

afterAll(async () => { await client?.close(); });

describe('the wire', () => {
  it('serves exactly the capture-front-door tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['capture', 'doctor', 'link', 'link_status', 'list_runs', 'read_run', 'submit_daf']);
    // None of appendix D's read tools live here: that is the other server.
    expect(tools.map((t) => t.name)).not.toContain('search_entries');
  });
});

describe('reading a bundle', () => {
  it('list_runs: the newest bundle, one line per run, run_hash first, no content', async () => {
    const r = text(await client.callTool({ name: 'list_runs', arguments: {} })) as { bundle_id: string; upload_id: string; runs: { run_hash: string; turns: number; title: string }[]; daf_template: { daf_version: string; bundle_id: string } };
    expect(r.bundle_id).toBe(bundleId);
    expect(r.upload_id).toBe(uploadId);
    expect(r.runs.map((x) => [x.run_hash, x.turns])).toEqual([[HASH1, 6], [HASH2, 4], [HASH3, 3]]);
    expect(JSON.stringify(r)).not.toContain('turn 0 of');
    expect(r.daf_template.daf_version).toBe('0.2');
    expect(r.daf_template.bundle_id).toBe(bundleId);
  });

  it('read_run: a 16-character prefix is enough; turns come back with idx', async () => {
    const r = text(await client.callTool({ name: 'read_run', arguments: { run_hash: HASH2.slice(0, 16) } })) as { run_hash: string; turns: { idx: number; content: string }[] };
    expect(r.run_hash).toBe(HASH2);
    expect(r.turns.map((t) => t.idx)).toEqual([0, 1, 2, 3]);
    expect(r.turns[1]!.content).toBe('turn 1 of run:cc-2');
  });

  it('read_run: a prefix two runs share is refused as ambiguous; the full hash still wins', async () => {
    const amb = await client.callTool({ name: 'read_run', arguments: { run_hash: '1'.repeat(16) } });
    expect(amb.isError).toBe(true);
    expect((text(amb) as { error: { code: string } }).error.code).toBe('invalid_request');
    const exact = text(await client.callTool({ name: 'read_run', arguments: { run_hash: HASH1 } })) as { run_hash: string };
    expect(exact.run_hash).toBe(HASH1);
  });

  it('read_run: an unknown hash is a plain not_found, never a network call', async () => {
    const res = await client.callTool({ name: 'read_run', arguments: { run_hash: 'deadbeefdeadbeef' } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('submit_daf, up to the network boundary', () => {
  const good = () => ({
    daf_version: '0.2',
    analyzer: { kind: 'agent_session', model: 'test', skill_version: '1', prompt_version: 'test@1', produced_at: new Date().toISOString() },
    segments: [],
    entries: [{ type: 'decision', title: 'Streaming writer replaces buffering', body: 'because memory', confidence: 0.8, run_hash: HASH1, source_turn_idx: [2, 3] }],
    agent_states: [],
  });

  it('a shape error is daf_invalid with the paths, and nothing is sent', async () => {
    const res = await client.callTool({ name: 'submit_daf', arguments: { daf: { ...good(), entries: [{ type: 'decision', title: 'x' }] } } });
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; details: { issues: { path: string }[] } } };
    expect(e.error.code).toBe('daf_invalid');
    expect(e.error.details.issues.map((i) => i.path)).toContain('entries.0.body');
  });

  it('anchors that resolve to nothing: every item would be dropped, so nothing is sent', async () => {
    const daf = good();
    daf.entries = [{ ...daf.entries[0]!, source_turn_idx: [99] }];
    const res = await client.callTool({ name: 'submit_daf', arguments: { daf } });
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; details: { drops: { reason: string; note: string }[] } } };
    expect(e.error.code).toBe('daf_invalid');
    expect(e.error.details.drops[0]!.reason).toBe('anchor_unresolved');
    expect(e.error.details.drops[0]!.note).toContain('turn idx 99');
  });

  it('a valid DAF on an unlinked machine stops at not_linked', async () => {
    const res = await client.callTool({ name: 'submit_daf', arguments: { daf: good() } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('not_linked');
  });
});

describe('capture with a record', () => {
  it('dry_run writes the record into the inbox, scores it, uploads nothing', async () => {
    const record = {
      format: 'distill.chat/v1', platform: 'cowork', title: 'MCP smoke',
      turns: [
        { role: 'user', content: 'please capture this' },
        { role: 'assistant', content: 'captured, with the pipeline redacting', tools: ['Bash'] },
      ],
    };
    const r = text(await client.callTool({ name: 'capture', arguments: { record, dry_run: true, slug: 'mcp-smoke' } })) as
      { result: string; record_path: string; report: { runs_kept: number; cqs: number; verdict: string } };
    expect(r.result).toBe('dry_run');
    expect(r.report.runs_kept).toBe(1);
    expect(r.report.verdict).toBe('ok');
    expect(existsSync(r.record_path)).toBe(true);
    expect(r.record_path.endsWith('-mcp-smoke.chat.json')).toBe(true);
    expect(readdirSync(join(stateHome, 'inbox')).filter((f) => f.endsWith('.chat.json'))).toHaveLength(1);
    // Verbatim: the tool does not redact. That is the pipeline's job (C6).
    expect(JSON.parse(readFileSync(r.record_path, 'utf8')).turns[0].content).toBe('please capture this');
  });

  it('a credential in the record is redacted by the pipeline, and the report says so (C6)', async () => {
    const record = {
      format: 'distill.chat/v1', platform: 'cowork', title: 'leaky',
      turns: [{ role: 'user', content: 'use this key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefgh' }],
    };
    const r = text(await client.callTool({ name: 'capture', arguments: { record, dry_run: true, slug: 'leaky' } })) as
      { report: { redactions: Record<string, number> } };
    const total = Object.values(r.report.redactions).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('two records in the same second get different names; nothing is overwritten', async () => {
    const record = { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'a' }] };
    const before = readdirSync(join(stateHome, 'inbox')).length;
    await client.callTool({ name: 'capture', arguments: { record, dry_run: true, slug: 'same' } });
    await client.callTool({ name: 'capture', arguments: { record: { ...record, turns: [{ role: 'user', content: 'b' }] }, dry_run: true, slug: 'same' } });
    expect(readdirSync(join(stateHome, 'inbox')).length).toBe(before + 2);
  });

  it('a record that is not distill.chat/v1 is refused before anything is written', async () => {
    const res = await client.callTool({ name: 'capture', arguments: { record: { format: 'something-else', turns: [{ role: 'user', content: 'x' }] }, dry_run: true } });
    expect(res.isError).toBe(true);
    expect(readdirSync(join(stateHome, 'inbox')).filter((f) => f.endsWith('.chat.json')).some((f) => f.includes('something'))).toBe(false);
  });

  it('a real capture on an unlinked machine is refused up front, not after packing', async () => {
    const res = await client.callTool({ name: 'capture', arguments: { sources: ['cowork_live'] } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('not_linked');
  });
});

describe('the write guard, against a stub API', () => {
  // The core invariant of this server: a token that may not write never
  // reaches the pipeline. /api/v1/me is stubbed and switched between answers;
  // the MCP re-reads config on every call, so no restart is needed.
  let stub: Server;
  let me: Record<string, unknown> = { kind: 'agent', scopes: ['read'], workspace_id: null, user_id: null, agent_id: uuid(), via: 'pat', can_capture: false };
  let base = '';
  const writeConfig = () => writeFileSync(join(stateHome, 'config.json'), JSON.stringify({
    version: 1, api_url: base, token: 'distill_pat_stub', source_id: uuid(), redaction_profile: 'general', upload_diffs: true,
    disabled_redaction_rules: [], extra_paths: [], sources: [],
  }));

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (req.url === '/api/v1/me') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(me)); return; }
      res.statusCode = 404; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'stub' } }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    writeConfig();
  });
  afterAll(async () => {
    await new Promise<void>((r) => stub.close(() => r()));
    // Leave the machine unlinked again for the cases after this block.
    writeFileSync(join(stateHome, 'config.json'), JSON.stringify({ version: 1, redaction_profile: 'general', upload_diffs: true, disabled_redaction_rules: [], extra_paths: [], sources: [] }));
  });

  it('an agent token is refused before the pipeline runs', async () => {
    const before = readdirSync(join(stateHome, 'inbox')).length;
    const res = await client.callTool({ name: 'capture', arguments: { record: { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'x' }] } } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string; message: string } }).error.code).toBe('forbidden');
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/agent token/);
    expect(readdirSync(join(stateHome, 'inbox')).length).toBe(before);   // no record written
  });

  it('a user token without the capture scope is refused the same way', async () => {
    me = { kind: 'user', scopes: ['read'], workspace_id: uuid(), user_id: uuid(), agent_id: null, via: 'pat', can_capture: false };
    const res = await client.callTool({ name: 'submit_daf', arguments: { daf: { daf_version: '0.2', analyzer: { kind: 'agent_session', prompt_version: 'x', produced_at: new Date().toISOString() }, segments: [], entries: [], agent_states: [] } } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string; message: string } }).error.code).toBe('forbidden');
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/capture.*scope/);
  });

  it('a user token with capture scope passes the guard and reaches the pipeline', async () => {
    me = { kind: 'user', scopes: ['capture'], workspace_id: uuid(), user_id: uuid(), agent_id: null, via: 'pat', can_capture: true };
    const res = await client.callTool({ name: 'capture', arguments: { record: { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, slug: 'guarded' } });
    // The stub has no upload endpoints, so the pipeline runs and the upload
    // fails: that failure, not a guard refusal, is the proof the guard opened.
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; message: string; details?: { bundle_dir?: string } } };
    expect(e.error.code).not.toBe('forbidden');
    expect(e.error.message).toMatch(/Upload failed/);
    expect(e.error.details?.bundle_dir).toBeTruthy();
  });

  it('when /me cannot be reached the guard fails closed', async () => {
    const port = (stub.address() as { port: number }).port;
    await new Promise<void>((r) => stub.close(() => r()));
    const res = await client.callTool({ name: 'submit_daf', arguments: { daf: { daf_version: '0.2', analyzer: { kind: 'agent_session', prompt_version: 'x', produced_at: new Date().toISOString() }, segments: [], entries: [], agent_states: [] } } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/Could not verify the token/);
    // bring it back for afterAll's close() to have something to close
    stub = createServer((_q, res) => { res.statusCode = 404; res.end(); });
    await new Promise<void>((r) => stub.listen(port, '127.0.0.1', () => r()));
  });
});

describe('link', () => {
  it('validates the token before writing anything: an unreachable API leaves no config', async () => {
    const res = await client.callTool({ name: 'link', arguments: { api_url: 'http://127.0.0.1:9', token: 'distill_pat_nothing_here' } });
    expect(res.isError).toBe(true);
    // The guard block above left an unlinked config behind; link must not have added a token to it.
    const cfg = existsSync(join(stateHome, 'config.json')) ? JSON.parse(readFileSync(join(stateHome, 'config.json'), 'utf8')) as { token?: string; api_url?: string } : {};
    expect(cfg.token).toBeUndefined();
    expect(cfg.api_url).toBeUndefined();
  });

  it('refuses a URL that is not http(s) without touching the network', async () => {
    const res = await client.callTool({ name: 'link', arguments: { api_url: 'ftp://example.com', token: 'distill_pat_nothing_here' } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('with no token it starts a browser sign-in; an unreachable API says so and writes nothing', async () => {
    const res = await client.callTool({ name: 'link', arguments: { api_url: 'http://127.0.0.1:9', method: 'code' } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { message: string } }).error.message).toContain('Could not reach');
    const cfg = existsSync(join(stateHome, 'config.json')) ? JSON.parse(readFileSync(join(stateHome, 'config.json'), 'utf8')) as { token?: string } : {};
    expect(cfg.token).toBeUndefined();
  });

  it('link_status with nothing in progress says to call link', async () => {
    const res = await client.callTool({ name: 'link_status', arguments: { wait_seconds: 0 } });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('doctor', () => {
  it('reports the machine, and that it is not linked', async () => {
    const r = text(await client.callTool({ name: 'doctor', arguments: {} })) as { linked: boolean; sources: { adapter: string }[] };
    expect(r.linked).toBe(false);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.some((s) => s.adapter.startsWith('cowork_live@'))).toBe(true);
  });
});
