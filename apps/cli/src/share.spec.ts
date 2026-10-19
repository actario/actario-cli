import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UNMASK_MARKER_NAME } from '@distill/export';
import { writeEncrypted } from '@distill/redaction';
import { SEAL_MAGIC, uuid, type ShareCreate, type TranscriptRun, type TranscriptTurn } from '@distill/shared';
import type { ApiOptions } from './api.ts';
import { fetchRunToCache, findRestored, readRestoredAnswer, restoreAnswer } from './core/restore.ts';
import { createShare, openShare, revealMap, seal, unseal } from './core/share.ts';

/**
 * Sharing on the machine side (arch v2.1 22.4-22.5), against a fake API that
 * speaks the share routes and a fake storage that takes the sealed upload.
 * What these pin down: the sealed format opens with WebCrypto (what the /s/
 * page uses); real values never reach the server in the clear; keys, tokens
 * and redaction_terms never come back even in a share; a share lands in its
 * own folder, never over the person's own copy; and a share that could not
 * be sealed is revoked rather than left half-made.
 */

const SALT = 'abcdef0123456789abcdef0123456789';
const H1 = `a1${'b2c3d4e5'.repeat(7)}f6a7b8`;
const RUN1 = '70000000-0000-4000-8000-000000000001';
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const PACK = '80000000-0000-4000-8000-000000000001';

const RUN: TranscriptRun = {
  id: RUN1, run_hash: H1, title: '寄給 EMAIL-3F2A91 的信', platform: 'claude_code', model: null, started_at: '2026-10-01T02:00:00.000Z',
  ended_at: null, outcome: 'completed', turns: 4, agent: null, workspace_id: WS,
};
const TURNS: TranscriptTurn[] = Array.from({ length: 4 }, (_, idx) => ({
  idx, role: idx % 2 ? 'assistant' : 'user', timestamp: null, tool_calls: null, result_truncated: false, content_cleared: false,
  content: `turn ${idx}: EMAIL-3F2A91 用 KEY-0A1B2C 連到 TERM-77AA00`, tool_result: idx === 1 ? 'path USER-5E5E5E' : null,
}));

interface FakeShare {
  id: string; token: string; body: ShareCreate; sealed: Buffer | null; sha: string | null; revoked: boolean;
}
const fake = {
  shares: new Map<string, FakeShare>(),
  failUpload: false,
  calls: [] as string[],
};

let base = '';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((r) => { const parts: Buffer[] = []; req.on('data', (c: Buffer) => parts.push(c)); req.on('end', () => r(Buffer.concat(parts))); });
}

async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://x');
  fake.calls.push(`${req.method} ${url.pathname}`);
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const byToken = (t: string) => [...fake.shares.values()].find((s) => s.token === t && !s.revoked);

  if (url.pathname === '/api/v1/me') return send(200, { kind: 'user', scopes: ['read', 'capture'], workspace_id: WS, user_id: uuid(), agent_id: null, via: 'pat', can_capture: true });
  if (/^\/api\/v1\/runs\/[^/]+\/transcript$/.test(url.pathname)) {
    return send(200, { run: RUN, turns: TURNS, next_from: null, segments: [], page: null, artifacts: [] });
  }
  if (url.pathname === '/api/v1/memory-packs/' + PACK) {
    const body = '---\nformat: actario.memory/v1\n---\n# 記憶\n\n寫給 EMAIL-3F2A91。\n';
    return send(200, {
      pack: { id: PACK, workspace_id: WS, title: '記憶', scope: {}, current_version: 2, created_at: RUN.started_at, updated_at: RUN.started_at },
      shown: { version: 2, as_of: RUN.started_at, budget: 'M', body, anchors: [], run_ids: [], client_prompt_version: null, created_at: RUN.started_at },
      versions: [],
    });
  }
  if (url.pathname === '/api/v1/shares' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8')) as ShareCreate;
    const id = uuid();
    const token = randomBytes(32).toString('base64url');
    fake.shares.set(id, { id, token, body, sealed: null, sha: null, revoked: false });
    return send(201, {
      share_id: id, token, url: `${base}/s/${token}`, expires_at: '2026-11-07T00:00:00.000Z',
      upload: body.reveal ? { signed_url: `${base}/storage/upload/${id}`, path: `${WS}/${id}.bin` } : null,
    });
  }
  const up = /^\/storage\/upload\/([^/]+)$/.exec(url.pathname);
  if (up && req.method === 'PUT') {
    if (fake.failUpload) return send(500, { error: 'boom' });
    fake.shares.get(up[1]!)!.sealed = await readBody(req);
    return send(200, {});
  }
  const sealedRoute = /^\/api\/v1\/shares\/([^/]+)\/sealed$/.exec(url.pathname);
  if (sealedRoute) {
    const s = fake.shares.get(sealedRoute[1]!)!;
    s.sha = (JSON.parse((await readBody(req)).toString('utf8')) as { sha256: string }).sha256;
    return send(200, { share_id: s.id, sealed_path: `${WS}/${s.id}.bin` });
  }
  const blob = /^\/storage\/blob\/([^/]+)$/.exec(url.pathname);
  if (blob) {
    const s = fake.shares.get(blob[1]!);
    if (!s?.sealed) return send(404, {});
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(s.sealed);
  }
  const content = /^\/api\/v1\/shares\/([^/]+)\/content$/.exec(url.pathname);
  if (content) {
    const s = byToken(content[1]!);
    if (!s) return send(404, { error: { code: 'not_found', message: 'No such share' } });
    if (s.body.object.type === 'memory') {
      return send(200, { body: '# 共享記憶\n\n- EMAIL-3F2A91 的事\n', anchors: [], version: 1, as_of: RUN.started_at, budget: 'M' });
    }
    const from = Number(url.searchParams.get('from') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
    const page = TURNS.filter((t) => t.idx >= from).slice(0, limit);
    const next = TURNS.find((t) => t.idx >= from + limit)?.idx ?? null;
    return send(200, { turns: page, next_from: next, ...(from === 0 ? { segments: [], page: null, artifacts: [] } : {}) });
  }
  const one = /^\/api\/v1\/shares\/([^/]+)$/.exec(url.pathname);
  if (one && req.method === 'DELETE') {
    const s = fake.shares.get(one[1]!);
    if (!s) return send(404, { error: { code: 'not_found', message: 'No such share' } });
    s.revoked = true;
    return send(200, { share_id: s.id, revoked: true, sealed_file_deleted: s.sealed !== null });
  }
  if (one && req.method === 'GET') {
    const s = byToken(one[1]!);
    if (!s) return send(404, { error: { code: 'not_found', message: 'No such share' } });
    const perms = s.body.permissions ?? ['view', 'restore'];
    if (url.searchParams.get('action') === 'restore' && !perms.includes('restore')) return send(403, { error: { code: 'forbidden', message: 'no restore' } });
    return send(200, {
      share_id: s.id, object_type: s.body.object.type, title: '分享的對話', permissions: perms, audience: s.body.audience,
      revealed: !!s.body.reveal, web_view: true, expires_at: '2026-11-07T00:00:00.000Z',
      shared_by: { email: 'a@example.test', name: 'Ann' }, is_owner: false,
      object: s.body.object.type === 'run' ? { run_hash: H1, platform: 'claude_code', model: null, started_at: RUN.started_at, ended_at: null, turns: 4 } : { pack_id: PACK, version: 1 },
      download: s.body.reveal ? { url: `${base}/storage/blob/${s.id}`, sha256: s.sha } : null,
    });
  }
  return send(404, { error: { code: 'not_found', message: url.pathname } });
}

let server: Server;
let api: ApiOptions;
let home: string;

beforeAll(async () => {
  server = createServer((req, res) => { void serve(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  api = { baseUrl: base, token: 'distill_pat_test' };
});
afterAll(() => { server?.close(); });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'actario-share-'));
  process.env.ACTARIO_HOME = home;
  fake.shares.clear(); fake.failUpload = false; fake.calls.length = 0;
});

function writeMap() {
  writeFileSync(join(home, 'salt'), `${SALT}\n`);
  writeEncrypted(join(home, 'redaction_map.json.enc'), SALT, {
    version: 1,
    entries: [
      { original: 'kestrel@example.com', pseudonym: 'EMAIL-3F2A91' },
      { original: 'sk-live-0000000000', pseudonym: 'KEY-0A1B2C' },
      { original: 'Project Heron', pseudonym: 'TERM-77AA00' },
      { original: 'kestrel', pseudonym: 'USER-5E5E5E' },
    ],
  });
}

describe('the sealed file', () => {
  it('round-trips, and WebCrypto (what the /s/ page uses) opens the same bytes', async () => {
    const payload = { format: 'actario.share/v1', hello: '你好 kestrel@example.com' };
    const s = seal(payload);
    expect(s.bytes.subarray(0, 5).toString('ascii')).toBe(SEAL_MAGIC);
    expect(s.sha256).toBe(createHash('sha256').update(s.bytes).digest('hex'));
    expect(unseal(s.bytes, s.key)).toEqual(payload);

    const k = await webcrypto.subtle.importKey('raw', s.key, 'AES-GCM', false, ['decrypt']);
    const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: s.bytes.subarray(5, 17) }, k, s.bytes.subarray(17));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(payload);
  });

  it('a wrong key or a damaged file is refused, not half-read', () => {
    const s = seal({ a: 1 });
    expect(() => unseal(s.bytes, randomBytes(32))).toThrow(/does not open/);
    const bad = Buffer.from(s.bytes); bad[bad.length - 1]! ^= 1;
    expect(() => unseal(bad, s.key)).toThrow(/does not open/);
    expect(() => unseal(Buffer.from('nope'), s.key)).toThrow(/not a sealed/);
  });
});

describe('revealMap', () => {
  it('never includes what hard rules or redaction_terms produced', () => {
    expect(revealMap()).toBeNull();
    writeMap();
    const m = revealMap()!;
    expect(m.get('EMAIL-3F2A91')).toBe('kestrel@example.com');
    expect(m.get('USER-5E5E5E')).toBe('kestrel');
    expect(m.has('KEY-0A1B2C')).toBe(false);
    expect(m.has('TERM-77AA00')).toBe(false);
  });

  it('drops a soft original that holds a listed term (an email at that client\'s domain)', () => {
    writeMap();
    expect(revealMap(['example.com'])!.has('EMAIL-3F2A91')).toBe(false);
    expect(revealMap(['example.com'])!.get('USER-5E5E5E')).toBe('kestrel');
  });
});

describe('createShare', () => {
  it('a masked share is one request: no sealing, no key in the link', async () => {
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'link' });
    expect(out.revealed).toBe(false);
    expect(out.url).not.toContain('#k=');
    expect(fake.calls.filter((c) => !c.startsWith('GET /api/v1/me'))).toEqual(['POST /api/v1/shares']);
  });

  it('real values need this machine\'s map: without it nothing is created', async () => {
    await expect(createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org', reveal: true })).rejects.toThrow(/machine that captured/);
    expect(fake.shares.size).toBe(0);
  });

  it('real values are sealed here: the server gets ciphertext, the key rides in #k=, keys and terms stay masked', async () => {
    writeMap();
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'users', recipients: ['c@example.test'], reveal: true });
    expect(out.revealed).toBe(true);
    expect(out.url).toMatch(/\/s\/[A-Za-z0-9_-]{43}#k=[A-Za-z0-9_-]{43}$/);
    expect(out.values_shown).toBeGreaterThan(0);
    expect(out.values_still_masked).toBeGreaterThan(0); // KEY- and TERM- are still there

    const s = [...fake.shares.values()][0]!;
    expect(s.body.object).toEqual({ type: 'run', run: H1 });
    expect(s.sealed).not.toBeNull();
    expect(s.sha).toBe(createHash('sha256').update(s.sealed!).digest('hex'));
    const onServer = s.sealed!.toString('latin1');
    expect(onServer).not.toContain('kestrel');
    expect(onServer).not.toContain('EMAIL-3F2A91');
  });

  it('a share whose sealed file could not be uploaded is revoked, not left half-made', async () => {
    writeMap();
    fake.failUpload = true;
    await expect(createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org', reveal: true })).rejects.toThrow(/Uploading the sealed file failed/);
    const s = [...fake.shares.values()][0]!;
    expect(s.revoked).toBe(true);
    expect(fake.calls).toContain(`DELETE /api/v1/shares/${s.id}`);
  });

  it('a memory pack with real values seals the uploaded version', async () => {
    writeMap();
    const out = await createShare(api, { object: { type: 'memory', pack_id: PACK }, audience: 'org', reveal: true });
    expect(out.url).toContain('#k=');
    const s = [...fake.shares.values()][0]!;
    expect(s.body.object).toEqual({ type: 'memory', pack_id: PACK, version: 2 });
  });
});

describe('openShare', () => {
  it('a sealed share opens with the key from the link, into its own folder, never over the person\'s own copy', async () => {
    writeMap();
    // The person's own (masked) copy of the same run.
    const own = await fetchRunToCache(api, RUN1);
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org', reveal: true });

    const o = await openShare(api, out.url);
    expect(o.kind).toBe('run');
    if (o.kind !== 'run') return;
    expect(o.restored.dir).not.toBe(own.dir);
    expect(o.restored.dir).toMatch(/share-[0-9a-f]{16}$/);
    expect(o.restored.turns[0]!.content).toBe('turn 0: kestrel@example.com 用 KEY-0A1B2C 連到 TERM-77AA00');
    expect(o.restored.turns[1]!.tool_result).toBe('path kestrel');
    expect(existsSync(join(o.restored.dir, UNMASK_MARKER_NAME))).toBe(true);

    // The own copy is untouched and is what the hash still finds.
    expect(readFileSync(join(own.dir, 'turns.jsonl'), 'utf8')).toContain('EMAIL-3F2A91');
    const found = findRestored(H1.slice(0, 12));
    expect(found && found !== 'ambiguous' ? found.dir : null).toBe(own.dir);

    const a = restoreAnswer(o.restored, 'transcript') as { source: string; shared?: { shared_by: string | null; real_values: boolean } };
    expect(a.source).toBe('share');
    expect(JSON.stringify(a)).toContain('Ann');
  });

  it('a sealed share without its #k= part is refused with what is missing', async () => {
    writeMap();
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org', reveal: true });
    await expect(openShare(api, out.url.split('#')[0]!)).rejects.toThrow(/#k= is missing/);
  });

  it('a masked share is paged down, and its pseudonyms cannot be reversed by the recipient', async () => {
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org' });
    writeMap(); // even a recipient whose own map happens to hold the same pseudonym
    const o = await openShare(api, out.url);
    if (o.kind !== 'run') throw new Error('expected a run');
    expect(o.restored.turns).toHaveLength(4);
    expect(o.restored.turns[0]!.content).toContain('EMAIL-3F2A91');
    const r = readRestoredAnswer(o.restored, { from: 0, to: 3, unmask: true, reverse: null }) as { text: string; unmask: { applied: boolean; note: string } };
    expect(r.unmask.applied).toBe(false);
    expect(r.unmask.note).toMatch(/only its owner/);
    expect(r.text).toContain('EMAIL-3F2A91');
  });

  it('a share that does not allow restore says so', async () => {
    const out = await createShare(api, { object: { type: 'run', run: RUN1 }, audience: 'org', permissions: ['view'] });
    await expect(openShare(api, out.url)).rejects.toThrow(/did not allow restore/);
  });

  it('a shared memory lands under memory/shared-<share_id>/', async () => {
    const out = await createShare(api, { object: { type: 'memory', pack_id: PACK }, audience: 'org' });
    const o = await openShare(api, out.url);
    if (o.kind !== 'memory') throw new Error('expected a memory');
    expect(o.path).toBe(join(home, 'memory', `shared-${o.opened.share_id}`, 'memory.md'));
    expect(readFileSync(o.path, 'utf8')).toContain('共享記憶');
    expect(JSON.parse(readFileSync(join(home, 'memory', `shared-${o.opened.share_id}`, 'share.json'), 'utf8')).shared_by).toBe('Ann');
  });

  it('not a share link, or no link to the account, is said plainly', async () => {
    await expect(openShare(api, 'https://example.test/runs/abc')).rejects.toThrow(/not an Actario share link/);
    await expect(openShare(null, `https://example.test/s/${'a'.repeat(43)}`)).rejects.toThrow(/linked/);
  });
});
