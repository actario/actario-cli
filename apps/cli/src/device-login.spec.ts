import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startDeviceLogin } from './core/device-login.ts';

/**
 * Sign in from Claude, the machine half, against a stub Actario that speaks
 * the four endpoints involved. The real server is covered by the RLS spec
 * (supabase/tests/rls/device-login.spec.ts) and the e2e run.
 */

const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRC = '50000000-0000-4000-8000-0000000000aa';
const TOKEN = 'distill_pat_from-the-device-flow';

let server: Server;
let base: string;
let home: string;
let codeBody: Record<string, unknown> | null;
let codeBodies: Record<string, unknown>[];
let tokenBodies: Record<string, unknown>[];
/** What the token endpoint answers, in order; the last one repeats. */
let script: { status: number; body: unknown }[];
let polls: number;
let startInterval: number;
let codeStatus: number;
let bearerSeen: string | null;

const readJson = (req: IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s ? JSON.parse(s) as Record<string, unknown> : {}));
});
const pending = { status: 400, body: { error: { code: 'authorization_pending', message: 'waiting' } } };
const approved = { status: 200, body: { access_token: TOKEN, workspace: { id: WS, name: 'Research' }, email: 'a@x.test' } };
const denied = { status: 403, body: { error: { code: 'access_denied', message: 'no' } } };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'actario-login-'));
  process.env.ACTARIO_HOME = home;
  server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'POST' && req.url === '/api/v1/device/code') {
        codeBody = await readJson(req);
        codeBodies.push(codeBody);
        if (codeStatus !== 200) return send(codeStatus, {});
        return send(200, {
          device_code: 'dc_'.padEnd(43, 'x'), user_code: 'BCDF-GH23',
          verification_uri: `${base}/link`, verification_uri_complete: `${base}/link?code=BCDF-GH23`,
          expires_in: 600, interval: startInterval,
        });
      }
      if (req.method === 'POST' && req.url === '/api/v1/device/token') {
        tokenBodies.push(await readJson(req));
        const r = script[Math.min(polls, script.length - 1)]!;
        polls++;
        return send(r.status, r.body);
      }
      if (req.url === '/api/v1/me') {
        bearerSeen = req.headers.authorization ?? null;
        return send(200, { kind: 'user', scopes: ['read', 'capture'], workspace_id: WS, user_id: 'u', agent_id: null, via: 'pat', can_capture: true });
      }
      if (req.url === '/api/v1/sources' && req.method === 'GET') return send(200, { sources: [] });
      if (req.url === '/api/v1/sources' && req.method === 'POST') {
        const b = await readJson(req);
        return send(201, { id: SRC, label: b.label, platform: 'local', capture_method: 'local_file', profile: 'general', created_at: new Date().toISOString(), last_capture_at: null });
      }
      send(404, {});
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { codeBody = null; codeBodies = []; tokenBodies = []; script = [pending]; polls = 0; startInterval = 1; codeStatus = 200; bearerSeen = null; });

describe('code flow (no browser, no local port)', () => {
  it('shows the code, polls until approved, then links with the new token', async () => {
    script = [pending, approved];
    const login = await startDeviceLogin({ apiUrl: base, loopback: false, openBrowser: false, label: 'test-box' });
    expect(login.prompt).toMatchObject({ user_code: 'BCDF-GH23', browser_opened: false, loopback: false });
    expect(codeBody).toMatchObject({ client_host: 'test-box' });
    expect(codeBody).not.toHaveProperty('redirect_uri');

    const r = await login.done;
    expect(r.email).toBe('a@x.test');
    expect(r.workspace_name).toBe('Research');
    expect(r.source.id).toBe(SRC);
    expect(bearerSeen).toBe(`Bearer ${TOKEN}`);
    const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(cfg).toMatchObject({ api_url: base, token: TOKEN, source_id: SRC });
    expect(login.state().status).toBe('linked');
  });

  it('a decline ends it with access_denied and writes nothing new', async () => {
    script = [pending, denied];
    const login = await startDeviceLogin({ apiUrl: base, loopback: false, openBrowser: false });
    await expect(login.done).rejects.toMatchObject({ code: 'access_denied' });
    expect(login.state()).toMatchObject({ status: 'failed', error: { code: 'access_denied' } });
  });

  it('a server without the device endpoints says to use a token instead', async () => {
    codeStatus = 404;
    await expect(startDeviceLogin({ apiUrl: base, loopback: false, openBrowser: false }))
      .rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Access tokens') });
  });

  it('cancel stops the polling', async () => {
    const login = await startDeviceLogin({ apiUrl: base, loopback: false, openBrowser: false });
    login.cancel();
    await expect(login.done).rejects.toMatchObject({ code: 'expired_token' });
  });
});

const APPROVAL = 'a'.repeat(64);

/** GET with a chosen Host header (fetch will not let us set one). */
const rawGet = (url: string, host?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const u = new URL(url);
  const r = httpRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: host ? { host } : {} }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
  });
  r.on('error', reject);
  r.end();
});

describe('loopback flow', () => {
  it('asks for a 127.0.0.1 redirect, opens the browser at the code URL, and the callback finishes it at once', async () => {
    startInterval = 30; // without the callback, the next poll would be 30 s away
    script = [pending];
    const launched: string[] = [];
    const login = await startDeviceLogin({ apiUrl: base, launch: async (u) => { launched.push(u); return true; } });
    expect(launched).toEqual([`${base}/link?code=BCDF-GH23`]);
    expect(login.prompt).toMatchObject({ browser_opened: true, loopback: true });
    const redirect = String(codeBody?.redirect_uri);
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Let the first poll happen, then "approve in the browser".
    await new Promise((r) => setTimeout(r, 200));
    expect(polls).toBe(1);
    expect(tokenBodies[0]).not.toHaveProperty('approval_code');
    script = [pending, approved];

    const t0 = Date.now();
    const page = await (await fetch(`${redirect}?status=approved&code=${APPROVAL}`)).text();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(page).toContain('Linked');
    expect(page).toContain('Research');
    // The poll after the callback carried the approval code the page handed over.
    expect(tokenBodies.at(-1)).toMatchObject({ approval_code: APPROVAL });
    const r = await login.done;
    expect(r.source.id).toBe(SRC);
  });

  it('no browser after all → starts over as a plain code request (a loopback one would be unredeemable elsewhere)', async () => {
    script = [pending];
    const login = await startDeviceLogin({ apiUrl: base, launch: async () => false });
    expect(codeBodies).toHaveLength(2);
    expect(codeBodies[0]).toHaveProperty('redirect_uri');
    expect(codeBodies[1]).not.toHaveProperty('redirect_uri');
    expect(login.prompt).toMatchObject({ browser_opened: false, loopback: false });
    login.cancel();
    await expect(login.done).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('the local port answers only a well-formed callback, addressed to itself', async () => {
    script = [pending, denied];
    startInterval = 30;
    const login = await startDeviceLogin({ apiUrl: base, launch: async () => true });
    const redirect = String(codeBody?.redirect_uri);
    const origin = new URL(redirect).origin;
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/callback`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${redirect}?status=approved`)).status).toBe(400);            // no approval code
    expect((await fetch(`${redirect}?status=approved&code=zz`)).status).toBe(400);
    // DNS rebinding: a page on evil.test resolving to 127.0.0.1 sends its own Host.
    expect((await rawGet(`${redirect}?status=denied`, `evil.test:${new URL(redirect).port}`)).status).toBe(404);
    // A declined sign-in: the tab says so.
    const page = await (await fetch(`${redirect}?status=denied`)).text();
    expect(page).toContain('Declined');
    await expect(login.done).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('never launches anything but a web URL', async () => {
    const { openInBrowser } = await import('./core/device-login.ts');
    for (const bad of ['file:///tmp/x.command', '\\\\evil\\share\\x.exe', 'C:\\Windows\\calc.exe', 'javascript:alert(1)', 'https://ok.test/a b']) {
      expect(await openInBrowser(bad), bad).toBe(false);
    }
  });
});
