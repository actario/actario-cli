import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { readConfig } from '@distill/capture';
import { DistillError, actarioEnv, type ErrorCode } from '@distill/shared';
import { linkMachine, type LinkResult } from './link.ts';

/**
 * "Sign in from Claude": link this machine by logging in to Actario in a
 * browser, instead of creating a token in Settings and pasting it into the
 * chat (migration 20260930000200, web /link).
 *
 * Two ways to finish, one mechanism (Jacky asked for both, to test them):
 *
 *   loopback   listen on 127.0.0.1:<random port>, open the browser at the
 *              approval page; after approval the page sends the browser to
 *              http://127.0.0.1:<port>/callback, which makes us collect the
 *              token at once and show the result in that tab.
 *   code       show a URL and an 8-character code; the person approves on
 *              any device. We poll every 5 s.
 *
 * The token always comes from POST /api/v1/device/token with our
 * device_code, which never leaves this process. A loopback request also
 * needs the one-time approval code that the approval page hands to our
 * callback -- in the browser of the person who approved, on this machine.
 * That is what makes a phished link worthless: the attacker's CLI would
 * wait for a callback that goes to the victim's own 127.0.0.1. For the
 * same reason loopback is only used when a browser opens HERE; otherwise
 * (SSH, containers, the Cowork VM) it is the code flow from the start.
 *
 * The token is a normal user PAT with read + capture, for the workspace the
 * person picked, and does not expire (Jacky, 2026-09-30). It is listed as
 * "Claude · <hostname>" under Settings → Access tokens and revoked there.
 */

/** Where to sign in when nothing says otherwise: the hosted Actario. */
export const DEFAULT_API_URL = 'https://distill-web-ten.vercel.app';

export function defaultApiUrl(): string {
  return (readConfig().api_url ?? actarioEnv('API_URL') ?? DEFAULT_API_URL).replace(/\/+$/, '');
}

export interface DevicePrompt {
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  /** A browser was launched at verification_uri_complete (it may still not be visible). */
  browser_opened: boolean;
  /** Finishing in that browser comes straight back here. */
  loopback: boolean;
}

export interface DeviceLoginOptions {
  apiUrl?: string;
  /** Shown on the approval page. */
  clientName?: string;
  label?: string;
  profile?: 'general' | 'medical';
  /** Default: true, unless ACTARIO_NO_BROWSER is set. */
  openBrowser?: boolean;
  /** Default: true when a browser can open here. false = code flow only, no local port. */
  loopback?: boolean;
  /** Tests: replace the browser launcher. */
  launch?: (url: string) => Promise<boolean>;
}

export type DeviceLoginResult = LinkResult & { email: string | null; workspace_name: string | null; api_url: string };

export interface DeviceLogin {
  prompt: DevicePrompt;
  /** Resolves when linked; rejects on denied / expired / cancelled. */
  done: Promise<DeviceLoginResult>;
  /** What happened so far, for a status tool. */
  state(): { status: 'waiting' | 'linked' | 'failed'; error?: { code: string; message: string } };
  cancel(): void;
}

type TokenOk = { access_token: string; token_id?: string; workspace: { id: string; name: string | null }; email: string | null };

async function post<T>(base: string, path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; message: string }> {
  let res: Response;
  try {
    res = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, code: 'network', message: (e as Error).message };
  }
  const json = await res.json().catch(() => null) as ({ error?: { code?: string; message?: string } } & T) | null;
  if (res.ok && json) return { ok: true, data: json };
  return { ok: false, status: res.status, code: json?.error?.code ?? `http_${res.status}`, message: json?.error?.message ?? `${res.status} ${res.statusText}` };
}

/**
 * Is there a desktop here to open a browser on? Decides the flow up front:
 * a loopback request is only redeemable by the machine it redirects to, so
 * it is only worth asking for when the browser will open HERE. (No display
 * -- SSH, a container, the Cowork VM -- means the code flow.)
 */
export function canOpenBrowser(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Best-effort: open the default browser at an http(s) URL. Never throws;
 * says whether it launched something.
 *
 * The URL comes from the server, so it is checked here: on Windows
 * `url.dll,FileProtocolHandler` will happily run an .exe or a UNC path, and
 * macOS `open` launches .app and .command files. Only a plain web URL goes.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || /[\s"'`]/.test(url)) return false;
  if (!canOpenBrowser()) return false;
  const plat = process.platform;
  const [cmd, args] = plat === 'win32'
    // Not `start`: it is a cmd builtin, and cmd would read the URL's
    // characters as its own syntax. rundll32 takes the URL as one argument,
    // and spawn passes it without a shell.
    ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]]
    : plat === 'darwin' ? ['open', [u.href]] : ['xdg-open', [u.href]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function resultPage(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Actario · ${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--ink:#18181b;--muted:#52525b;--line:#e4e4e7;--mark:${ok ? '#15803d' : '#b91c1c'}}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f10;--ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--mark:${ok ? '#4ade80' : '#f87171'}}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:460px;border:1px solid var(--line);border-radius:12px;padding:24px 26px}
h1{font-size:19px;margin:0 0 8px;display:flex;gap:10px;align-items:center}
h1::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--mark)}
p{margin:0;color:var(--muted)}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/** Listen on the loopback interface only, on a port the OS picks. */
async function listenLoopback(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { server, port: addr.port };
}

type CodeResponse = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };

const MAX_INTERVAL_MS = 30_000;

export async function startDeviceLogin(opts: DeviceLoginOptions = {}): Promise<DeviceLogin> {
  const apiUrl = (opts.apiUrl ?? defaultApiUrl()).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(apiUrl)) throw new DistillError('invalid_request', 'api_url must start with http:// or https://');
  const launch = opts.launch ?? openInBrowser;
  const wantBrowser = opts.openBrowser ?? !actarioEnv('NO_BROWSER');
  const canLaunch = wantBrowser && (opts.launch ? true : canOpenBrowser());

  const requestCode = async (redirect: string | null): Promise<CodeResponse> => {
    const r = await post<CodeResponse>(apiUrl, '/api/v1/device/code', {
      client_name: opts.clientName ?? 'Actario CLI',
      client_host: opts.label ?? hostname(),
      ...(redirect ? { redirect_uri: redirect } : {}),
    });
    if (r.ok) return r.data;
    if (r.status === 404 || r.status === 405) {
      throw new DistillError('not_found',
        `${apiUrl} does not support signing in from Claude yet (no /api/v1/device/code). Link with a token from Settings → Access tokens instead.`);
    }
    if (r.code === 'network') throw new DistillError('internal', `Could not reach ${apiUrl}: ${r.message}`, undefined, 502);
    throw new DistillError(r.code as ErrorCode, r.message, undefined, r.status);
  };

  // 1. The local door -- only if a browser will open on this machine.
  //    Failing to bind is not an error; it is the code flow.
  let local: { server: Server; port: number } | null = null;
  if (opts.loopback !== false && canLaunch) {
    try { local = await listenLoopback(); } catch { local = null; }
  }

  // 2. A code, then the browser. If the browser does not open after all,
  //    the loopback request is useless to anyone else (it can only be
  //    redeemed through this machine's callback), so start over as a plain
  //    code request the person can approve from any device.
  let s: CodeResponse;
  try {
    s = await requestCode(local ? `http://127.0.0.1:${local.port}/callback` : null);
  } catch (e) {
    local?.server.close();
    throw e;
  }
  const launched = canLaunch ? await launch(s.verification_uri_complete) : false;
  if (local && !launched) {
    local.server.close();
    local = null;
    s = await requestCode(null);
  }

  const prompt: DevicePrompt = {
    verification_uri: s.verification_uri,
    verification_uri_complete: s.verification_uri_complete,
    user_code: s.user_code,
    expires_in: s.expires_in,
    browser_opened: launched,
    loopback: local !== null,
  };

  // 3. Poll until approved, denied, expired or cancelled. `wake` cuts the
  //    current wait short (the callback arrived).
  let cancelled = false;
  let approvalCode: string | null = null;
  let wake: (() => void) | null = null;
  let state: ReturnType<DeviceLogin['state']> = { status: 'waiting' };
  const deadline = Date.now() + s.expires_in * 1000;
  let interval = Math.max(1, s.interval) * 1000;

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  const poll = async (): Promise<TokenOk> => {
    for (;;) {
      if (cancelled) throw new DistillError('expired_token', 'Sign-in was cancelled.');
      if (Date.now() > deadline) throw new DistillError('expired_token', 'The sign-in code expired before it was approved. Start again.');
      const r = await post<TokenOk>(apiUrl, '/api/v1/device/token', {
        device_code: s.device_code, ...(approvalCode ? { approval_code: approvalCode } : {}),
      });
      if (r.ok) return r.data;
      if (r.code === 'authorization_pending' || r.code === 'network' || r.status >= 500) { await sleep(interval); continue; }
      if (r.code === 'slow_down') { interval = Math.min(MAX_INTERVAL_MS, interval + 5000); await sleep(interval); continue; }
      if (r.code === 'access_denied') throw new DistillError('access_denied', 'The sign-in was declined in the browser. Nothing was linked.', undefined, 403);
      throw new DistillError((r.code as ErrorCode) ?? 'expired_token', r.message, undefined, r.status);
    }
  };

  /** A token we cannot use is revoked, not left in Settings with nobody holding it. */
  const revoke = async (tok: TokenOk) => {
    if (!tok.token_id) return;
    await fetch(new URL(`/api/v1/tokens/${tok.token_id}`, apiUrl), {
      method: 'DELETE', headers: { authorization: `Bearer ${tok.access_token}` },
    }).catch(() => undefined);
  };

  const done: Promise<DeviceLoginResult> = (async () => {
    const tok = await poll();
    if (cancelled) { await revoke(tok); throw new DistillError('expired_token', 'Sign-in was cancelled.'); }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const linked = await linkMachine({
          apiUrl, token: tok.access_token,
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.profile ? { profile: opts.profile } : {}),
        });
        return { ...linked, email: tok.email, workspace_name: tok.workspace.name, api_url: apiUrl };
      } catch (e) {
        lastErr = e;
        if ((e as DistillError).code !== 'internal') break; // a refusal, not a hiccup
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    await revoke(tok);
    const m = (lastErr as Error)?.message ?? String(lastErr);
    throw new DistillError((lastErr as DistillError)?.code ?? 'internal',
      `Signed in, but registering this machine failed (${m}). The new key was revoked; run the sign-in again.`);
  })();
  done.then(
    () => { state = { status: 'linked' }; },
    (e: unknown) => {
      const err = e as DistillError;
      state = { status: 'failed', error: { code: err.code ?? 'internal', message: err.message } };
    },
  );

  // 4. The callback: take the approval code, poll now, show the answer in
  //    the tab. Only for requests addressed to exactly this port (a page on
  //    some other name that resolves to 127.0.0.1 -- DNS rebinding -- gets
  //    nothing), and only with a well-formed status.
  if (local) {
    const expectedHost = `127.0.0.1:${local.port}`;
    local.server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || req.method !== 'GET' || req.headers.host !== expectedHost) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const status = url.searchParams.get('status');
      const code = url.searchParams.get('code');
      // Keep the first well-formed code: the real one arrives with the
      // browser, and a later one could only be something else on this
      // machine hitting the port.
      if (status === 'approved' && code && /^[0-9a-f]{64}$/.test(code)) approvalCode ??= code;
      else if (status !== 'denied') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      (wake as (() => void) | null)?.();
      const settled = Promise.race([
        done.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e: e as DistillError })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      void settled.then((out) => {
        const html = out === null
          ? resultPage('Almost there', 'Approved. Actario is finishing the link on this machine; go back to Claude, it will confirm there.', true)
          : out.ok
            ? resultPage('Linked', `This machine is linked to ${out.r.workspace_name ?? 'your workspace'}${out.r.email ? ` as ${out.r.email}` : ''}. You can close this tab and go back to Claude.`, true)
            : resultPage(out.e.code === 'access_denied' ? 'Declined' : 'Not linked', out.e.message, false);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(html);
      });
    });
    const server = local.server;
    const closeLocal = () => setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 20_000).unref();
    done.then(closeLocal, closeLocal);
    server.unref();
  }

  return {
    prompt,
    done,
    state: () => state,
    cancel: () => { cancelled = true; (wake as (() => void) | null)?.(); },
  };
}
