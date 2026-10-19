import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { uuid } from '@distill/shared';

/**
 * One computer, two people (core/profiles.ts): A and B each link this
 * computer to their own Actario account, each with their own Claude account
 * and so their own passes. Every call lands in the home of the person whose
 * pass it carries -- their token, their inbox, their salt -- and a scan of
 * the computer's session folders is refused, since those are not anyone's
 * in particular.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/actario.js');

const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = { user: '11111111-1111-4111-8111-111111111111', token: 'distill_pat_aaaaaaaaaaaaaaaa', pass: `actario_pass_${'A'.repeat(43)}` };
const B = { user: '22222222-2222-4222-8222-222222222222', token: 'distill_pat_bbbbbbbbbbbbbbbb', pass: `actario_pass_${'B'.repeat(43)}` };
const A2 = 'distill_pat_aaaaaaaaaaaaaaa2';   // A re-linking with a fresh token

let api: Server;
let base = '';
let home: string;
let client: Client;

const people = new Map([[A.token, A], [A2, A], [B.token, B]]);
const send = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const body = (req: IncomingMessage) => new Promise<string>((r) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => r(s)); });
const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0]!.text);

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const who = people.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!who) return send(res, 401, { error: { code: 'unauthorized', message: 'no' } });
    if (req.url === '/api/v1/me') return send(res, 200, { kind: 'user', scopes: ['read', 'capture'], workspace_id: WS, user_id: who.user, agent_id: null, via: 'pat', can_capture: true });
    if (req.url === '/api/v1/sources' && req.method === 'GET') return send(res, 200, { sources: [] });
    if (req.url === '/api/v1/sources' && req.method === 'POST') {
      const b = JSON.parse(await body(req)) as { label: string };
      return send(res, 201, { id: uuid(), workspace_id: WS, user_id: who.user, platform: 'local', capture_method: 'local_file', label: b.label, profile: 'general', upload_diffs: true, created_at: new Date().toISOString() });
    }
    if (req.url === '/api/v1/local-pass') {
      const { pass } = JSON.parse(await body(req)) as { pass: string };
      if (pass !== who.pass) return send(res, 403, { error: { code: 'forbidden', message: 'not yours' } });
      return send(res, 200, { client_name: 'Claude', expires_at: new Date(Date.now() + 3600_000).toISOString(), workspace_id: WS, scopes: ['read', 'capture'] });
    }
    return send(res, 404, { error: { code: 'not_found', message: req.url } });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  home = mkdtempSync(join(tmpdir(), 'actario-profiles-'));
  const actario = join(home, '.actario');
  mkdirSync(actario, { recursive: true });
  client = new Client({ name: 'profiles-spec', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', BIN, 'mcp'],
    env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: actario, HOME: home, USERPROFILE: home, ACTARIO_API_URL: '', ACTARIO_TOKEN: '', ACTARIO_SOURCE_ID: '' } as Record<string, string>,
    stderr: 'pipe',
  }));
}, 30_000);

afterAll(async () => { await client?.close(); await new Promise<void>((r) => api.close(() => r())); });

const record = (content: string) => ({ format: 'distill.chat/v1', platform: 'cowork', title: content, turns: [{ role: 'user', content }, { role: 'assistant', content: 'ok' }] });

describe('two people, one computer', () => {
  it('the first link goes to ~/.actario; a second person gets a home of their own, and the first link stays', async () => {
    const a = text(await client.callTool({ name: 'link', arguments: { api_url: base, token: A.token } }));
    expect(a.config_path).toBe(join(home, '.actario', 'config.json'));
    expect(a.shared_machine).toBeUndefined();
    const b = text(await client.callTool({ name: 'link', arguments: { api_url: base, token: B.token } }));
    expect(b.config_path).toMatch(/[\\/]\.actario[\\/]profiles[\\/]22222222-aaaaaaaa-[0-9a-f]{6}[\\/]config\.json$/);
    expect(b.shared_machine).toMatch(/home of their own/);
    expect(JSON.parse(readFileSync(join(home, '.actario', 'config.json'), 'utf8')).token).toBe(A.token);
    expect(JSON.parse(readFileSync(b.config_path, 'utf8'))).toMatchObject({ token: B.token, identity: { user_id: B.user, workspace_id: WS } });
  });

  it('re-linking the same person replaces their token in their own home, no third home', async () => {
    const again = text(await client.callTool({ name: 'link', arguments: { api_url: base, token: A2 } }));
    expect(again.config_path).toBe(join(home, '.actario', 'config.json'));
    expect(readdirSync(join(home, '.actario', 'profiles'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, '.actario', 'config.json'), 'utf8')).token).toBe(A2);
  });

  it('each pass lands in its own person\'s home: A\'s record in A\'s inbox, B\'s in B\'s', async () => {
    const ra = text(await client.callTool({ name: 'capture', arguments: { record: record('from A'), dry_run: true, slug: 'a', pass: A.pass } }));
    const rb = text(await client.callTool({ name: 'capture', arguments: { record: record('from B'), dry_run: true, slug: 'b', pass: B.pass } }));
    expect(ra.result).toBe('dry_run');
    expect(rb.result).toBe('dry_run');
    expect(ra.record_path.startsWith(join(home, '.actario', 'inbox'))).toBe(true);
    expect(rb.record_path).toMatch(/[\\/]profiles[\\/]22222222-[^\\/]+[\\/]inbox[\\/]/);
    // each home has its own salt: the same email would get a different pseudonym under each person
    const profile = readdirSync(join(home, '.actario', 'profiles'))[0]!;
    expect(existsSync(join(home, '.actario', 'salt'))).toBe(true);
    expect(existsSync(join(home, '.actario', 'profiles', profile, 'salt'))).toBe(true);
    expect(readFileSync(join(home, '.actario', 'salt'), 'utf8')).not.toBe(readFileSync(join(home, '.actario', 'profiles', profile, 'salt'), 'utf8'));
  });

  it('a pass that belongs to nobody linked here is refused, naming what to do', async () => {
    const r = text(await client.callTool({ name: 'list_runs', arguments: { pass: `actario_pass_${'Z'.repeat(43)}` } }));
    expect(r.error.code).toBe('pass_invalid');
    expect(r.error.message).toMatch(/linked to 2 accounts/);
  });

  it('scanning the computer\'s session folders is refused once two people are linked', async () => {
    const r = text(await client.callTool({ name: 'capture', arguments: { sources: ['claude_code'], dry_run: true, pass: A.pass } }));
    expect(r.error.code).toBe('shared_machine');
  });

  it('doctor lists both accounts, ids only', async () => {
    const d = text(await client.callTool({ name: 'doctor', arguments: {} }));
    expect(d.accounts_on_this_machine.map((x: { user_id: string }) => x.user_id).sort()).toEqual([A.user, B.user]);
    expect(JSON.stringify(d)).not.toContain('distill_pat_');
  });
});
