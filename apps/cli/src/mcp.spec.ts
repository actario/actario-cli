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

/**
 * A stand-in for the Actario API: who the token is (/me) and whether a local
 * pass is good (/local-pass). Every tool but link, link_status and doctor
 * needs a pass from the Actario connector of the Claude account in use
 * (arch v2.1 ch. 22 addendum); this is the one it accepts.
 */
const PASS = `actario_pass_${'P'.repeat(43)}`;
let api: Server;
let apiBase = '';
let me: Record<string, unknown> = {};
let meDown = false;
const passChecks: string[] = [];
const searchCalls: string[] = [];
const weeklyCalls: string[] = [];
const weeklyBodies: unknown[] = [];
const LINE_ID = '0b1e0000-0000-4000-8000-0000000000aa';
const READ_PASS = `actario_pass_${'R'.repeat(43)}`;
/** A local key (arch v3.1 23.12) the stub accepts, and one it refuses (revoked). */
const KEY = `actario_lkey_${'K'.repeat(32)}`;
const DEAD_KEY = `actario_lkey_${'D'.repeat(32)}`;
const userMe = () => ({ kind: 'user', scopes: ['read', 'capture'], workspace_id: uuid(), user_id: uuid(), agent_id: null, via: 'pat', can_capture: true });
const linkedConfig = (token = 'distill_pat_stub') => writeFileSync(join(stateHome, 'config.json'), JSON.stringify({
  version: 1, api_url: apiBase, token, source_id: uuid(), redaction_profile: 'general', upload_diffs: true,
  disabled_redaction_rules: [], extra_paths: [], sources: [],
}));
const unlinkedConfig = () => writeFileSync(join(stateHome, 'config.json'), JSON.stringify({
  version: 1, redaction_profile: 'general', upload_diffs: true, disabled_redaction_rules: [], extra_paths: [], sources: [],
}));
/** Arguments with the pass. */
const P = <T extends Record<string, unknown>>(a: T) => ({ ...a, pass: PASS });
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

  me = userMe();
  api = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v1/me') {
      if (meDown) { req.socket.destroy(); return; }
      return send(200, me);
    }
    if (req.url === '/api/v1/local-pass' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { pass } = JSON.parse(raw) as { pass: string };
        passChecks.push(pass);
        if (pass === PASS) return send(200, { client_name: 'Claude', expires_at: new Date(Date.now() + 3600_000).toISOString(), workspace_id: uuid(), scopes: ['read', 'capture'] });
        if (pass === READ_PASS) return send(200, { client_name: 'Claude', expires_at: new Date(Date.now() + 3600_000).toISOString(), workspace_id: uuid(), scopes: ['read'] });
        if (pass === KEY) return send(200, { client_name: 'Local key · desk', expires_at: new Date(Date.now() + 600_000).toISOString(), workspace_id: uuid(), scopes: ['read', 'capture'], via: 'local_key' });
        return send(403, { error: { code: 'forbidden', message: 'no' } });
      });
      return;
    }
    if (req.url?.startsWith('/api/v1/search?')) {
      searchCalls.push(req.url);
      return send(200, {
        q: '逾時', lines: [], runs: [],
        pages: [{ run_id: 'r1', page_title: '上傳逾時修正', run_title: 'x', agent_id: null, last_active: '2026-10-14T00:00:00Z', section: 2, heading: '修逾時', start_turn_idx: 2, end_turn_idx: 8, snippet: '修好逾時' }],
        segments: [], turns: [{ run_id: 'r1', run_title: 'x', agent_id: null, idx: 3, role: 'user', timestamp: null, snippet: '一上傳就逾時' }],
        more: { lines: false, runs: false, pages: false, segments: false, turns: false },
      });
    }
    // ── weekly reports (2026-10-18) ──
    if (req.url === '/api/v1/dashboard') return send(200, { agents: [{ id: LINE_ID, name: 'Actario 網頁' }, { id: uuid(), name: 'Billing' }] });
    if (req.url?.startsWith(`/api/v1/agents/${LINE_ID}/reports/`)) {
      weeklyCalls.push(`${req.method} ${req.url}`);
      const u = new URL(req.url, 'http://x');
      const format = u.searchParams.get('format');
      if (req.method === 'PUT') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { weeklyBodies.push(JSON.parse(raw)); send(200, { id: 'w1', week: '2026-W42', url: '/acta/x/reports/2026-W42' }); });
        return;
      }
      if (format === 'docx') return send(403, { error: { code: 'plan_required', message: 'Exporting is included from Lite up.' } });
      if (format) {
        res.statusCode = 200;
        res.setHeader('content-disposition', `attachment; filename="w.${format}"; filename*=UTF-8''${encodeURIComponent(`Actario 網頁-2026-W42-weekly.${format}`)}`);
        return res.end(Buffer.from(`file-${format}`));
      }
      return send(200, { line: { id: LINE_ID, name: 'Actario 網頁' }, week: { label: '2026-W42' }, author: 'assembled', report: { headline: 'h' }, sources: [] });
    }
    send(404, { error: { code: 'not_found', message: 'stub' } });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  linkedConfig();

  client = new Client({ name: 'mcp-spec', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', BIN, 'mcp'],
    env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: stateHome, HOME: home, USERPROFILE: home, ACTARIO_API_URL: '', ACTARIO_TOKEN: '', ACTARIO_SOURCE_ID: '' } as Record<string, string>,
    stderr: 'pipe',
  }));
}, 30_000);

afterAll(async () => { await client?.close(); await new Promise<void>((r) => (api ? api.close(() => r()) : r())); });

describe('the wire', () => {
  it('serves exactly the capture-front-door tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'capture', 'contacts', 'create_share', 'doctor', 'download_weekly_report', 'fetch_memory_sources', 'fetch_run', 'find_runs', 'fork_share', 'inbox', 'link', 'link_status',
      'list_runs', 'list_shares', 'load_memory', 'make_deck', 'message_identity', 'message_status', 'open_share', 'read_message', 'read_restored', 'read_run', 'read_staged', 'reply',
      'revoke_share', 'save_memory', 'save_weekly_report', 'search', 'send_message', 'set_local_key', 'set_message_state', 'stage_sessions', 'submit_daf', 'suggest_line',
      'upload_rules', 'upload_staged', 'weekly_report_sources',
    ]);
    // None of appendix D's read tools live here: that is the other server.
    expect(tools.map((t) => t.name)).not.toContain('search_entries');
  });
});

describe('the account binding: a pass from the connector of the Claude account in use', () => {
  it('no pass: refused with how to get one, before anything is read', async () => {
    const res = await client.callTool({ name: 'list_runs', arguments: {} });
    expect(res.isError).toBe(true);
    const e = (text(res) as { error: { code: string; message: string } }).error;
    expect(e.code).toBe('pass_required');
    expect(e.message).toContain('local_pass');
    expect(e.message).toContain(`${apiBase}/api/mcp`);
  });

  it('a malformed pass never reaches the server; one the server refuses is pass_invalid', async () => {
    const n = passChecks.length;
    const bad = await client.callTool({ name: 'read_run', arguments: { run_hash: HASH1, pass: 'hello' } });
    expect((text(bad) as { error: { code: string } }).error.code).toBe('pass_invalid');
    expect(passChecks.length).toBe(n);
    const other = await client.callTool({ name: 'read_run', arguments: { run_hash: HASH1, pass: `actario_pass_${'Q'.repeat(43)}` } });
    expect((text(other) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'pass_invalid' });
    expect((text(other) as { error: { message: string } }).error.message).toMatch(/this machine is not linked to/);
  });

  it('every tool but link, link_status and doctor asks for it', async () => {
    const { tools } = await client.listTools();
    const without = tools.filter((t) => !Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).includes('pass')).map((t) => t.name).sort();
    expect(without).toEqual(['doctor', 'link', 'link_status']);
  });

  it('a pass from an AI account connected for reading only cannot capture', async () => {
    const res = await client.callTool({ name: 'capture', arguments: { record: { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'x' }] }, pass: READ_PASS } });
    expect((text(res) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'forbidden' });
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/reading only/);
    const read = await client.callTool({ name: 'list_runs', arguments: { pass: READ_PASS } });
    expect(read.isError).toBeFalsy();
  });

  it('a good pass is checked once, then remembered for a while', async () => {
    const n = passChecks.length;
    await client.callTool({ name: 'list_runs', arguments: P({}) });
    await client.callTool({ name: 'list_runs', arguments: P({}) });
    expect(passChecks.length - n).toBeLessThanOrEqual(1);
  });
});

describe('a local key: the door without the connector (arch v3.1 23.12)', () => {
  const cfg = () => JSON.parse(readFileSync(join(stateHome, 'config.json'), 'utf8')) as { local_key?: string };
  const err = (r: unknown) => (text(r) as { error: { code: string; message: string } }).error;

  it('set_local_key refuses what is not a key, and a key that opens nothing; neither is written', async () => {
    linkedConfig();
    expect(err(await client.callTool({ name: 'set_local_key', arguments: { key: 'actario_pass_x' } })).code).toBe('invalid_request');
    const dead = await client.callTool({ name: 'set_local_key', arguments: { key: DEAD_KEY } });
    expect(err(dead).code).toBe('forbidden');
    expect(err(dead).message).toMatch(/not saved/);
    expect(cfg().local_key).toBeUndefined();
  });

  it('a key the server accepts is saved, and then the tools answer without a pass', async () => {
    linkedConfig();
    const saved = text(await client.callTool({ name: 'set_local_key', arguments: { key: KEY } })) as { saved: boolean; key_name: string };
    expect(saved).toMatchObject({ saved: true, key_name: 'Local key · desk' });
    expect(cfg().local_key).toBe(KEY);
    const status = text(await client.callTool({ name: 'set_local_key', arguments: {} })) as { accounts_on_this_machine: { local_key: boolean }[] };
    expect(status.accounts_on_this_machine.map((a) => a.local_key)).toEqual([true]);
    expect(JSON.stringify(status)).not.toContain(KEY);
    const r = await client.callTool({ name: 'list_runs', arguments: {} });
    expect(r.isError).toBeFalsy();
    // A capture-scoped key may write: the write guard does not stop it at the pass.
    const doc = text(await client.callTool({ name: 'doctor', arguments: {} })) as { accounts_on_this_machine: { local_key: boolean }[] };
    expect(doc.accounts_on_this_machine[0]!.local_key).toBe(true);
  });

  it('a key that was revoked on the web: local_key_invalid, with the way out', async () => {
    writeFileSync(join(stateHome, 'config.json'), JSON.stringify({ ...cfg(), local_key: DEAD_KEY }));
    const e = err(await client.callTool({ name: 'list_runs', arguments: {} }));
    expect(e.code).toBe('local_key_invalid');
    expect(e.message).toMatch(/local_pass/);
  });

  it('a pass, when given, is still what decides; a key is never accepted as a pass', async () => {
    writeFileSync(join(stateHome, 'config.json'), JSON.stringify({ ...cfg(), local_key: KEY }));
    const e = err(await client.callTool({ name: 'read_run', arguments: { run_hash: HASH1, pass: `actario_pass_${'Q'.repeat(43)}` } }));
    expect(e.code).toBe('pass_invalid');
    // Pasted into a chat once, a key must not keep working as `pass` after it is removed from the computer.
    const n = passChecks.length;
    const k = err(await client.callTool({ name: 'read_run', arguments: { run_hash: HASH1, pass: KEY } }));
    expect(k.code).toBe('pass_invalid');
    expect(k.message).toMatch(/never passed as `pass`/);
    expect(passChecks.length).toBe(n);
  });

  it('remove deletes it from this computer, and no pass is again pass_required', async () => {
    const r = text(await client.callTool({ name: 'set_local_key', arguments: { remove: true } })) as { removed: number };
    expect(r.removed).toBe(1);
    expect(cfg().local_key).toBeUndefined();
    const e = err(await client.callTool({ name: 'list_runs', arguments: {} }));
    expect(e.code).toBe('pass_required');
    expect(e.message).toMatch(/set_local_key/);
    linkedConfig();
  });
});

describe('reading a bundle', () => {
  it('list_runs: the newest bundle, one line per run, run_hash first, no content', async () => {
    const r = text(await client.callTool({ name: 'list_runs', arguments: P({}) })) as { bundle_id: string; upload_id: string; runs: { run_hash: string; turns: number; title: string }[]; daf_template: { daf_version: string; bundle_id: string } };
    expect(r.bundle_id).toBe(bundleId);
    expect(r.upload_id).toBe(uploadId);
    expect(r.runs.map((x) => [x.run_hash, x.turns])).toEqual([[HASH1, 6], [HASH2, 4], [HASH3, 3]]);
    expect(JSON.stringify(r)).not.toContain('turn 0 of');
    expect(r.daf_template.daf_version).toBe('0.2');
    expect(r.daf_template.bundle_id).toBe(bundleId);
  });

  it('read_run: a 16-character prefix is enough; turns come back with idx', async () => {
    const r = text(await client.callTool({ name: 'read_run', arguments: P({ run_hash: HASH2.slice(0, 16) }) })) as { run_hash: string; turns: { idx: number; content: string }[] };
    expect(r.run_hash).toBe(HASH2);
    expect(r.turns.map((t) => t.idx)).toEqual([0, 1, 2, 3]);
    expect(r.turns[1]!.content).toBe('turn 1 of run:cc-2');
  });

  it('read_run: a prefix two runs share is refused as ambiguous; the full hash still wins', async () => {
    const amb = await client.callTool({ name: 'read_run', arguments: P({ run_hash: '1'.repeat(16) }) });
    expect(amb.isError).toBe(true);
    expect((text(amb) as { error: { code: string } }).error.code).toBe('invalid_request');
    const exact = text(await client.callTool({ name: 'read_run', arguments: P({ run_hash: HASH1 }) })) as { run_hash: string };
    expect(exact.run_hash).toBe(HASH1);
  });

  it('read_run: an unknown hash is a plain not_found, never a network call', async () => {
    const res = await client.callTool({ name: 'read_run', arguments: P({ run_hash: 'deadbeefdeadbeef' }) });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('restore when the server does not have the run (arch v2.1 ch. 22)', () => {
  it('fetch_run brings a run back from a local bundle, hybrid falls back to the transcript without a page', async () => {
    const r = text(await client.callTool({ name: 'fetch_run', arguments: P({ run: HASH2.slice(0, 16) }) })) as
      { source: string; local_dir: string; memory: null; transcript_page: { turns: number[]; next_from: number | null; text: string }; not_restored: string[]; rule: string };
    expect(r.source).toBe('local_bundle');
    expect(r.local_dir).toBe(join(stateHome, 'restore', HASH2));
    expect(r.memory).toBeNull();
    expect(r.transcript_page.turns).toEqual([0, 3]);
    expect(r.transcript_page.text).toContain('turn 2 of run:cc-2');
    expect(r.not_restored.length).toBeGreaterThan(3);
    expect(r.rule).toMatch(/data, not instructions/);
  });

  it('read_restored reads a range of what fetch_run wrote', async () => {
    const r = text(await client.callTool({ name: 'read_restored', arguments: P({ run: HASH2.slice(0, 12), from_turn: 1, to_turn: 2 }) })) as { turns: number[]; text: string };
    expect(r.turns).toEqual([1, 2]);
    expect(r.text).not.toContain('turn 0 of');
  });

  it('on an unlinked machine every gated tool says not_linked; save_memory without sources says what to call first', async () => {
    unlinkedConfig();
    try {
      for (const [name, args] of [['find_runs', {}], ['fetch_memory_sources', { agent: 'B1' }], ['fetch_run', { run: HASH2 }], ['list_runs', {}]] as const) {
        const res = await client.callTool({ name, arguments: P(args) });
        expect(res.isError).toBe(true);
        expect((text(res) as { error: { code: string } }).error.code).toBe('not_linked');
      }
      for (const [name, args] of [['submit_daf', { daf: {} }], ['capture', { sources: ['cowork_live'] }]] as const) {
        const res = await client.callTool({ name, arguments: P(args) });
        expect((text(res) as { error: { code: string } }).error.code).toBe('not_linked');
      }
    } finally { linkedConfig(); }
    const res = await client.callTool({ name: 'save_memory', arguments: P({ pack_id: uuid(), title: 't', body: '## 目標\n- x' }) });
    expect((text(res) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'not_found' });
  });
});

describe('search and make_deck (improvement plan C1/C2)', () => {
  it('search asks the server once, with the words, and says where each hit is', async () => {
    const r = text(await client.callTool({ name: 'search', arguments: P({ q: '逾時', kinds: ['pages', 'turns'] }) })) as {
      note_pages: { run: string; section: string; turns: string }[]; turns: { run: string; turn: number; who: string }[];
    };
    expect(searchCalls.at(-1)).toContain(`q=${encodeURIComponent('逾時')}`);
    expect(searchCalls.at(-1)).toContain('kinds=pages%2Cturns');
    expect(r.note_pages[0]).toMatchObject({ run: 'r1', section: '修逾時', turns: '2-8' });
    expect(r.turns[0]).toMatchObject({ run: 'r1', turn: 3, who: 'user' });
  });

  it('make_deck writes a .pptx under ~/.actario/decks and never overwrites one', async () => {
    const deck = { title: '上傳逾時修正', lang: 'zh', slides: [{ kind: 'bullets', heading: '重點', bullets: ['分段上傳'] }] };
    const a = text(await client.callTool({ name: 'make_deck', arguments: P({ deck }) })) as { path: string; slides: number };
    const b = text(await client.callTool({ name: 'make_deck', arguments: P({ deck }) })) as { path: string };
    expect(a.path.startsWith(join(stateHome, 'decks'))).toBe(true);
    expect(a.path.endsWith('.pptx')).toBe(true);
    expect(a.slides).toBe(2);
    expect(b.path).not.toBe(a.path);
    expect(readFileSync(a.path).subarray(0, 2).toString()).toBe('PK');
  });

  it('make_deck refuses a relative folder and a spec that is not one, and writes nothing', async () => {
    const before = existsSync(join(stateHome, 'decks')) ? readdirSync(join(stateHome, 'decks')).length : 0;
    const bad = await client.callTool({ name: 'make_deck', arguments: P({ deck: { title: 't', lang: 'en', slides: [{ kind: 'bullets', heading: 'h', bullets: ['x'] }] }, dir: 'relative/path' }) });
    expect(bad.isError).toBe(true);
    const shape = await client.callTool({ name: 'make_deck', arguments: P({ deck: { title: 't', slides: [] } }) });
    expect(shape.isError).toBe(true);
    expect(readdirSync(join(stateHome, 'decks')).length).toBe(before);
  });
});

describe('weekly reports (2026-10-18)', () => {
  it('weekly_report_sources finds the line by name and asks for the last full week, with its sources, in this machine\'s zone', async () => {
    const r = text(await client.callTool({ name: 'weekly_report_sources', arguments: P({ line: '網頁' }) })) as { week: { label: string }; next: string; tz: string };
    expect(r.week.label).toBe('2026-W42');
    expect(r.next).toContain(LINE_ID);
    const call = weeklyCalls.at(-1)!;
    expect(call).toContain(`GET /api/v1/agents/${LINE_ID}/reports/latest?`);
    expect(call).toContain('sources=1');
    expect(call).toContain(`tz=${encodeURIComponent(r.tz)}`);
  });

  it('a name that matches no line, or two, is an error that lists the lines', async () => {
    const none = await client.callTool({ name: 'weekly_report_sources', arguments: P({ line: 'nothing like it' }) });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(text(none))).toContain('Billing');
  });

  it('save_weekly_report stores the report, then writes the files it may, never over one', async () => {
    const report = { lang: 'zh', headline: '本週…' };
    const a = text(await client.callTool({ name: 'save_weekly_report', arguments: P({ line: LINE_ID, week: '2026-W42', report, model: 'm' }) })) as {
      saved: { id: string }; files: { format: string; path: string }[]; refused: { format: string; reason: string }[];
    };
    expect(weeklyBodies.at(-1)).toEqual({ report, model: 'm' });
    expect(a.saved.id).toBe('w1');
    expect(a.files.map((f) => f.format)).toEqual(['pptx', 'pdf', 'md']);
    expect(a.refused).toEqual([{ format: 'docx', reason: 'Exporting is included from Lite up.' }]);
    expect(a.files[0]!.path).toBe(join(stateHome, 'reports', 'Actario 網頁-2026-W42-weekly.pptx'));
    expect(readFileSync(a.files[0]!.path, 'utf8')).toBe('file-pptx');
    const b = text(await client.callTool({ name: 'download_weekly_report', arguments: P({ line: LINE_ID, week: '2026-W42', formats: ['pptx'] }) })) as { files: { path: string }[] };
    expect(b.files[0]!.path).toBe(join(stateHome, 'reports', 'Actario 網頁-2026-W42-weekly-2.pptx'));
  });

  it('save_weekly_report needs a pass that may write', async () => {
    const r = await client.callTool({ name: 'save_weekly_report', arguments: { line: LINE_ID, week: '2026-W42', report: {}, pass: READ_PASS } });
    expect(r.isError).toBe(true);
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
    const res = await client.callTool({ name: 'submit_daf', arguments: P({ daf: { ...good(), entries: [{ type: 'decision', title: 'x' }] } }) });
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; details: { issues: { path: string }[] } } };
    expect(e.error.code).toBe('daf_invalid');
    expect(e.error.details.issues.map((i) => i.path)).toContain('entries.0.body');
  });

  it('anchors that resolve to nothing: every item would be dropped, so nothing is sent', async () => {
    const daf = good();
    daf.entries = [{ ...daf.entries[0]!, source_turn_idx: [99] }];
    const res = await client.callTool({ name: 'submit_daf', arguments: P({ daf }) });
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; details: { drops: { reason: string; note: string }[] } } };
    expect(e.error.code).toBe('daf_invalid');
    expect(e.error.details.drops[0]!.reason).toBe('anchor_unresolved');
    expect(e.error.details.drops[0]!.note).toContain('turn idx 99');
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
    const r = text(await client.callTool({ name: 'capture', arguments: P({ record, dry_run: true, slug: 'mcp-smoke' }) })) as
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
    const r = text(await client.callTool({ name: 'capture', arguments: P({ record, dry_run: true, slug: 'leaky' }) })) as
      { report: { redactions: Record<string, number> } };
    const total = Object.values(r.report.redactions).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('two records in the same second get different names; nothing is overwritten', async () => {
    const record = { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'a' }] };
    const before = readdirSync(join(stateHome, 'inbox')).length;
    await client.callTool({ name: 'capture', arguments: P({ record, dry_run: true, slug: 'same' }) });
    await client.callTool({ name: 'capture', arguments: P({ record: { ...record, turns: [{ role: 'user', content: 'b' }] }, dry_run: true, slug: 'same' }) });
    expect(readdirSync(join(stateHome, 'inbox')).length).toBe(before + 2);
  });

  it('a record that is not distill.chat/v1 is refused before anything is written', async () => {
    const res = await client.callTool({ name: 'capture', arguments: P({ record: { format: 'something-else', turns: [{ role: 'user', content: 'x' }] }, dry_run: true }) });
    expect(res.isError).toBe(true);
    expect(readdirSync(join(stateHome, 'inbox')).filter((f) => f.endsWith('.chat.json')).some((f) => f.includes('something'))).toBe(false);
  });

});

describe('end of the day: stage, review, upload the chosen (acta-bye, 2026-10-19)', () => {
  it('stage_sessions stages without uploading, marks this conversation, and every line starts as review', async () => {
    const record = { format: 'distill.chat/v1', platform: 'cowork', title: '收工', project: 'Thesis', turns: [{ role: 'user', content: '整理今天的 session' }, { role: 'assistant', content: '好' }] };
    const r = text(await client.callTool({ name: 'stage_sessions', arguments: P({ record, slug: 'bye' }) })) as
      { result: string; stage_id: string; runs: { short: string; current: boolean; policy: string; line: { name: string } | null }[] };
    expect(r.result).toBe('staged');
    const cur = r.runs.filter((x) => x.current);
    expect(cur).toHaveLength(1);
    expect(cur[0]).toMatchObject({ policy: 'review', line: { name: 'Thesis conversations' } });

    const brief = text(await client.callTool({ name: 'read_staged', arguments: P({ run_hash: cur[0]!.short }) })) as { turns: { content: string }[] };
    expect(brief.turns[0]!.content).toBe('整理今天的 session');

    const rules = text(await client.callTool({ name: 'upload_rules', arguments: P({ set: [{ line: 'Thesis conversations', mode: 'auto' }] }) })) as { rules: { name: string; mode: string }[] };
    expect(rules.rules).toEqual([expect.objectContaining({ name: 'Thesis conversations', mode: 'auto' })]);

    const skip = text(await client.callTool({ name: 'upload_staged', arguments: P({ upload: [], skip: [cur[0]!.short] }) })) as { result: string; skipped: string[] };
    expect(skip).toMatchObject({ result: 'nothing_uploaded', skipped: [cur[0]!.short] });
  });

  it('upload_staged with runs to send needs a pass that may write', async () => {
    const res = await client.callTool({ name: 'upload_staged', arguments: { pass: READ_PASS, upload: ['0123456789ab'] } });
    expect(res.isError).toBe(true);
  });
});

describe('the write guard', () => {
  // The core invariant of this server: a token that may not write never
  // reaches the pipeline. /api/v1/me is switched between answers; the MCP
  // re-reads config on every call, so no restart is needed.
  beforeAll(() => { me = { kind: 'agent', scopes: ['read'], workspace_id: null, user_id: null, agent_id: uuid(), via: 'pat', can_capture: false }; });
  afterAll(() => { me = userMe(); meDown = false; });

  it('an agent token is refused before the pipeline runs', async () => {
    const before = readdirSync(join(stateHome, 'inbox')).length;
    const res = await client.callTool({ name: 'capture', arguments: P({ record: { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'x' }] } }) });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string; message: string } }).error.code).toBe('forbidden');
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/agent token/);
    expect(readdirSync(join(stateHome, 'inbox')).length).toBe(before);   // no record written
  });

  it('a user token without the capture scope is refused the same way', async () => {
    me = { kind: 'user', scopes: ['read'], workspace_id: uuid(), user_id: uuid(), agent_id: null, via: 'pat', can_capture: false };
    const res = await client.callTool({ name: 'submit_daf', arguments: P({ daf: { daf_version: '0.2', analyzer: { kind: 'agent_session', prompt_version: 'x', produced_at: new Date().toISOString() }, segments: [], entries: [], agent_states: [] } }) });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { code: string; message: string } }).error.code).toBe('forbidden');
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/capture.*scope/);
  });

  it('a user token with capture scope passes the guard and reaches the pipeline', async () => {
    me = { kind: 'user', scopes: ['capture'], workspace_id: uuid(), user_id: uuid(), agent_id: null, via: 'pat', can_capture: true };
    const res = await client.callTool({ name: 'capture', arguments: P({ record: { format: 'distill.chat/v1', turns: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, slug: 'guarded' }) });
    // The stub has no upload endpoints, so the pipeline runs and the upload
    // fails: that failure, not a guard refusal, is the proof the guard opened.
    expect(res.isError).toBe(true);
    const e = text(res) as { error: { code: string; message: string; details?: { bundle_dir?: string } } };
    expect(e.error.code).not.toBe('forbidden');
    expect(e.error.message).toMatch(/Upload failed/);
    expect(e.error.details?.bundle_dir).toBeTruthy();
  });

  it('when /me cannot be reached the guard fails closed', async () => {
    meDown = true;
    const res = await client.callTool({ name: 'submit_daf', arguments: P({ daf: { daf_version: '0.2', analyzer: { kind: 'agent_session', prompt_version: 'x', produced_at: new Date().toISOString() }, segments: [], entries: [], agent_states: [] } }) });
    expect(res.isError).toBe(true);
    expect((text(res) as { error: { message: string } }).error.message).toMatch(/Could not verify the token/);
  });
});

describe('link', () => {
  beforeAll(() => { unlinkedConfig(); });

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
