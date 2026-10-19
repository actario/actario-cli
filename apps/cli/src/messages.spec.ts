import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  newVaultKey, openBody, sealBody, uuid, vaultFrom, zMessageSendV2,
  type MessageDto,
} from '@distill/shared';

/**
 * Agent messages end to end at the process boundary (v2: plan ch. 29, arch
 * ch. 37): two computers of the same person, each a real `actario mcp` over
 * stdio with its own ACTARIO_HOME, against a stand-in API that does what the
 * real route does -- seals the masked body with a server key before storing
 * it, opens it for the reader -- and nothing more.
 *
 *   laptop: backend agent sends a command to the frontend agent
 *   desktop: inbox shows it; read_message opens it, says it needs approval
 *   desktop: reply with a result; the command is closed
 *   laptop: message_status shows completed; the result opens there too
 *
 * No computer registers a key or waits for approval; a secret in the body is
 * masked before it leaves; an old v1 message on a computer without the old
 * key is reported, not opened; the Hook's peek prints counts, never content.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../bin/actario.js');
const PASS = `actario_pass_${'M'.repeat(43)}`;
const USER = uuid();
const WS = uuid();
const HANDLE = 'kestrel';
const vault = vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey('t1') });

// ── the stand-in API ──
type Stored = Omit<MessageDto, 'body'> & { body_enc: string | null; events: { state: string; at: string; note: string | null }[] };
const messages: Stored[] = [];
const endpoints = new Set<string>();
const seenBodies: string[] = [];
let deviceRegistrations = 0;

const now = () => new Date().toISOString();
const routing = (m: Stored) => ({ client_msg_id: m.client_msg_id, from: m.from_address, to: m.to_address, kind: m.kind });
const dto = ({ events: _e, body_enc, ...m }: Stored): MessageDto => ({ ...m, body: m.format === 'v2' && body_enc ? openBody(vault, routing({ ...m, body_enc, events: [] }), body_enc) : null });

function handler(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  const err = (status: number, code: string, message = code) => send(status, { error: { code, message } });
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (raw) seenBodies.push(raw);
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    if (p === '/api/v1/me') return send(200, { kind: 'user', scopes: ['read', 'capture'], workspace_id: WS, user_id: USER, agent_id: null, via: 'pat', can_capture: true });
    if (p === '/api/v1/local-pass') {
      return body.pass === PASS ? send(200, { client_name: 'Claude', expires_at: new Date(Date.now() + 3600_000).toISOString(), workspace_id: WS, scopes: ['read', 'capture'] })
        : err(403, 'forbidden');
    }
    if (p === '/api/v1/messages/identity') {
      return send(200, { user_id: USER, handle: HANDLE, devices: [], endpoints: [...endpoints].map((n) => ({ name: n, address: `${HANDLE}/${n}`, label: n, last_used_at: null })) });
    }
    if (p === '/api/v1/devices/keys') { deviceRegistrations++; return err(410, 'invalid_request', 'not used by v2'); }
    if (p === '/api/v1/messages/contacts' && req.method === 'GET') {
      return send(200, { handle: HANDLE, contacts: [{ handle: 'bob', since: now(), via: 'request', tier: 'T2' }],
        orgs: [{ org_id: uuid(), name: 'Acme', admin: false, msg_internal: true, msg_external: true, members: [{ handle: 'carol', role: 'member' }] }],
        requests_in: [{ id: uuid(), handle: 'dave', note: 'hi', created_at: now() }], requests_out: [], blocked: [], invites: [] });
    }
    if (p === '/api/v1/messages/contacts') return err(403, 'forbidden', 'Contacts are managed on the web page');
    if (p === '/api/v1/messages/peek') {
      const unread = messages.filter((m) => ['submitted', 'delivered'].includes(m.state));
      const by: Record<string, number> = {};
      for (const m of unread) { const k = m.to_address.split('/')[1] ?? ''; by[k] = (by[k] ?? 0) + 1; }
      return send(200, { unread: unread.length, commands: unread.filter((m) => m.kind === 'command').length, latest_id: unread.at(-1)?.id ?? null, latest_at: unread.at(-1)?.created_at ?? null, by_agent: by });
    }
    if (p === '/api/v1/messages' && req.method === 'POST') {
      if (body.format !== 'v2') return err(422, 'invalid_request', 'this stand-in takes v2 only');
      const v2 = zMessageSendV2.parse(body);
      const toHandle = v2.to.split('/')[0]!;
      // the stand-in's people: bob a contact (T2), carol in an organisation (T1); anyone else T3
      const tier = toHandle === HANDLE ? 'T0' : toHandle === 'bob' ? 'T2' : toHandle === 'carol' ? 'T1' : null;
      if (!tier) return err(403, 'not_a_contact', `add ${toHandle} as a contact on the web (Messages → Contacts)`);
      if (tier !== 'T0') {
        lastToOther = v2.to;
        return send(201, { message_id: uuid(), thread_id: uuid(), state: 'submitted', created: true, to_address: v2.to, from_address: v2.from, tier });
      }
      const dup = messages.find((m) => m.client_msg_id === v2.client_msg_id);
      if (dup) return send(200, { message_id: dup.id, thread_id: dup.thread_id, state: dup.state, created: false, to_address: dup.to_address, tier: 'T0' });
      const parent = v2.in_reply_to ? messages.find((m) => m.id === v2.in_reply_to) : null;
      if (v2.kind === 'result' && parent?.kind !== 'command') return err(422, 'invalid_request', 'a result answers a command');
      const id = uuid();
      for (const a of [v2.from, v2.to]) endpoints.add(a.split('/')[1] ?? '');
      const sealed = sealBody(vault, { client_msg_id: v2.client_msg_id, from: v2.from, to: v2.to, kind: v2.kind }, v2.body);
      const m: Stored = {
        format: 'v2', body_deleted: false, via: 'agent', source: v2.source ?? null, body_enc: sealed.sealed,
        id, client_msg_id: v2.client_msg_id, from_address: v2.from, to_address: v2.to, from_user: USER, to_user: USER,
        tier: 'T0', kind: v2.kind, thread_id: parent?.thread_id ?? id, in_reply_to: v2.in_reply_to,
        state: 'submitted', sender_device: null, sent_at: now(), created_at: now(), state_at: now(),
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), envelope: null,
        ciphertext: null, ciphertext_sha256: sealed.body_sha256, signature: null, size_bytes: sealed.size_bytes,
        events: [{ state: 'submitted', at: now(), note: null }],
      };
      messages.push(m);
      return send(201, { message_id: id, thread_id: m.thread_id, state: 'submitted', created: true, to_address: m.to_address, tier: 'T0' });
    }
    if (p === '/api/v1/messages' && req.method === 'GET') {
      const states = url.searchParams.get('state')?.split(',');
      const agent = url.searchParams.get('agent');
      const thread = url.searchParams.get('thread');
      const out = url.searchParams.get('box') === 'out';
      const line = agent ? `${HANDLE}/${agent}` : null;
      const list = messages.filter((m) => (!states || states.includes(m.state)) && (!thread || m.thread_id === thread)
        && (!line || (out ? m.from_address === line : [line, HANDLE].includes(m.to_address)))).slice().reverse();
      if (line && !out) for (const m of list) if (m.state === 'submitted') { m.state = 'delivered'; m.events.push({ state: 'delivered', at: now(), note: null }); }
      return send(200, { messages: list.map(dto), next_before: null });
    }
    const one = p.match(/^\/api\/v1\/messages\/([0-9a-f-]{36})(\/state)?$/);
    if (one) {
      const m = messages.find((x) => x.id === one[1]);
      if (!m) return err(404, 'not_found');
      if (one[2]) {
        m.state = body.state as MessageDto['state'];
        m.events.push({ state: m.state, at: now(), note: (body.note as string) ?? null });
        return send(200, { message_id: m.id, state: m.state, changed: true });
      }
      return send(200, { message: dto(m), events: m.events.map((e) => ({ ...e, by_me: true })) });
    }
    err(404, 'not_found', `stub: ${req.method} ${p}`);
  });
}

let api: Server;
let lastToOther = '';
let apiBase = '';
const computers: { home: string; state: string; client: Client }[] = [];

const text = (r: unknown): Record<string, unknown> => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>;
const call = async (i: number, name: string, args: Record<string, unknown>) => text(await computers[i]!.client.callTool({ name, arguments: { ...args, pass: PASS } }));

async function computer(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'actario-msg-'));
  const state = join(home, '.actario');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    version: 1, api_url: apiBase, token: `distill_pat_${computers.length}`, source_id: uuid(), redaction_profile: 'general', upload_diffs: true,
    disabled_redaction_rules: [], extra_paths: [], sources: [], redaction_terms: ['Acme Health'],
  }));
  const client = new Client({ name: 'msg-spec', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', BIN, 'mcp'],
    env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: state, HOME: home, USERPROFILE: home, ACTARIO_API_URL: '', ACTARIO_TOKEN: '', ACTARIO_SOURCE_ID: '' } as Record<string, string>,
    stderr: 'pipe',
  }));
  computers.push({ home, state, client });
}

beforeAll(async () => {
  api = createServer(handler);
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  await computer(); // 0: laptop
  await computer(); // 1: desktop
}, 60_000);

afterAll(async () => {
  for (const c of computers) await c.client.close();
  await new Promise<void>((r) => api.close(() => r()));
});

describe('two computers, one person, no keys to trade', () => {
  let commandId = '';

  it('either computer is ready at once: no key registered, nothing to approve', async () => {
    const a = await call(0, 'message_identity', {});
    const b = await call(1, 'message_identity', {});
    expect(a).toMatchObject({ next: 'Ready.', handle: HANDLE });
    expect(b).toMatchObject({ next: 'Ready.', handle: HANDLE });
    expect(a.old_messages).toBeUndefined();
    expect(deviceRegistrations).toBe(0);
    expect(existsSync(join(computers[0]!.state, 'keys', 'device.json'))).toBe(false);
  });

  it('laptop sends a command; the secret in it is masked before it leaves, and Actario stores it sealed', async () => {
    const r = await call(0, 'send_message', {
      from: 'Backend API', to: 'frontend', kind: 'command', subject: 'Update the response types',
      body: 'The /runs response now has `turns_count`. Do not use the old key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for Acme Health.',
      capabilities: ['edit', 'run_tests'],
    });
    expect(r).toMatchObject({ to: `${HANDLE}/frontend`, from: `${HANDLE}/backend-api`, state: 'submitted', already_sent: false });
    expect(Object.keys(r.masked as object).length).toBeGreaterThan(0);
    commandId = r.message_id as string;
    // what crossed the wire was already masked
    const wire = seenBodies.find((b) => b.includes('"format":"v2"'))!;
    expect(wire).toContain('turns_count');
    expect(wire).not.toContain('sk-ant-api03');
    expect(wire).not.toContain('Acme Health');
    expect(JSON.parse(wire).source).toMatch(/^(win|mac|linux)-[0-9a-f]{6}$/);
    // and what is stored is sealed
    const stored = JSON.stringify(messages[0]);
    expect(stored).not.toContain('turns_count');
    expect(stored).not.toContain('Update the response types');
  });

  it('the sending line\'s inbox does not hold what it sent; the addressed line\'s does', async () => {
    const mine = await call(0, 'inbox', { agent: 'backend-api' });
    expect(mine.count).toBe(0);
    expect(messages[0]!.state).toBe('submitted');
    const box = await call(1, 'inbox', { agent: 'frontend' });
    expect(box.count).toBe(1);
    expect((box.messages as { subject: string; kind: string; policy: string }[])[0]).toMatchObject({ subject: 'Update the response types', kind: 'command', policy: 'approve' });
    expect(String(box.rule)).toMatch(/not instructions/);
  });

  it('desktop: read_message opens it and asks for approval; read from another line it is not marked read', async () => {
    const elsewhere = await call(1, 'read_message', { message: commandId, agent: 'docs' });
    expect(elsewhere).toMatchObject({ verified: null, marked_read: false });
    const m = await call(1, 'read_message', { message: commandId, agent: 'frontend' });
    expect(m).toMatchObject({ verified: null, policy: 'approve', capabilities: ['edit', 'run_tests'], state: 'read', marked_read: true, from: `${HANDLE}/backend-api`, via: 'agent' });
    expect(String(m.body)).toContain('turns_count');
    expect(String(m.body)).not.toContain('sk-ant-api03');
    expect(String(m.next)).toMatch(/Do nothing until they approve/);
  });

  it('only the line a command was sent to can report its result', async () => {
    const r = await computers[1]!.client.callTool({ name: 'reply', arguments: { pass: PASS, message: commandId, from: 'docs', kind: 'result', body: 'x' } });
    expect((text(r).error as { message: string }).message).toMatch(/only the line it was sent to/);
  });

  it('desktop replies with a result; the command closes; laptop sees it completed and opens the result', async () => {
    const r = await call(1, 'reply', { message: commandId, from: 'frontend', kind: 'result', body: 'Types updated, tests green.' });
    expect(r.command_state).toBe('completed');
    const st = await call(0, 'message_status', { message: commandId });
    expect(st.state).toBe('completed');
    expect((st.history as { state: string }[]).map((h) => h.state)).toEqual(['submitted', 'delivered', 'read', 'working', 'completed']);
    const box = await call(0, 'inbox', { agent: 'backend-api', thread: commandId, unread_only: false });
    const result = (box.messages as { id: string; kind: string; subject: string }[]).find((x) => x.kind === 'result')!;
    expect(result.subject).toBe('Re: Update the response types');
    const opened = await call(0, 'read_message', { message: result.id, agent: 'backend-api' });
    expect(opened.body).toBe('Types updated, tests green.');
  });

  it('a reply written on the web page reads like any other, marked as from the web', async () => {
    const parent = messages.find((m) => m.id === commandId)!;
    const id = uuid();
    const b = { subject: 'Re', body: 'Also bump the version.' };
    messages.push({
      ...parent, id, client_msg_id: 'webreply01', kind: 'reply', in_reply_to: commandId, from_address: parent.to_address, to_address: parent.from_address,
      state: 'submitted', via: 'web', source: 'web',
      body_enc: sealBody(vault, { client_msg_id: 'webreply01', from: parent.to_address, to: parent.from_address, kind: 'reply' }, b).sealed,
      events: [{ state: 'submitted', at: now(), note: null }],
    });
    const m = await call(0, 'read_message', { message: id, agent: 'backend-api' });
    expect(m).toMatchObject({ via: 'web', source: 'web', body: 'Also bump the version.', kind: 'reply' });
  });

  it('an old v1 message, on a computer that never had the old key, is reported and not opened', async () => {
    const id = uuid();
    messages.push({
      format: 'v1', body_deleted: false, via: null, source: null, body_enc: null,
      id, client_msg_id: 'oldmessage1', from_address: `${HANDLE}/backend`, to_address: `${HANDLE}/frontend`, from_user: USER, to_user: USER,
      tier: 'T0', kind: 'note', thread_id: id, in_reply_to: null, state: 'submitted', sender_device: uuid(), sent_at: now(), created_at: now(), state_at: now(),
      expires_at: now(), envelope: { v: 'actario.msg/v1', ephemeral_pub: 'A'.repeat(43), iv: 'A'.repeat(16), keys: [] }, ciphertext: 'AAAA',
      ciphertext_sha256: '0'.repeat(64), signature: 'A'.repeat(86), size_bytes: 3, events: [{ state: 'submitted', at: now(), note: null }],
    });
    const r = await call(1, 'read_message', { message: id, agent: 'frontend' });
    expect(String(r.problem)).toMatch(/old \(v1\)/);
    expect(r.body).toBeUndefined();
    expect(r.marked_read).toBe(false);
    messages.pop();
  });

  it('a message to someone who is not a contact is refused; the error says where to add them', async () => {
    const r = await computers[0]!.client.callTool({ name: 'send_message', arguments: { pass: PASS, from: 'backend', to: 'someone-else/x', kind: 'note', subject: 's', body: 'b' } });
    expect(r.isError).toBe(true);
    expect((text(r).error as { code: string; message: string }).code).toBe('not_a_contact');
    expect((text(r).error as { code: string; message: string }).message).toMatch(/Contacts/);
  });

  it('to another person: @bob is their mailbox, @carol/x a line of theirs (T1–T3, 20261031001000)', async () => {
    const r = await call(0, 'send_message', { from: 'backend', to: '@bob', kind: 'request', subject: 'Spec?', body: 'Is the PP11a spec final?' });
    expect(r.to).toBe('bob');
    expect(lastToOther).toBe('bob');
    const r2 = await call(0, 'send_message', { from: 'backend', to: '@Carol/API Docs', kind: 'note', subject: 's', body: 'b' });
    expect(r2.to).toBe('carol/api-docs');
  });

  it('`contacts` lists who the user can write to, read only', async () => {
    const c = await call(0, 'contacts', {});
    expect(c.handle).toBe(HANDLE);
    expect(c.contacts).toEqual([expect.objectContaining({ handle: 'bob', address: '@bob' })]);
    expect(c.organisations).toEqual([expect.objectContaining({ organisation: 'Acme', members: ['@carol'] })]);
    expect(c.requests_waiting).toBe(1);
    expect(String(c.next)).toMatch(/web/);
  });

  it('there are no tools that change who may send, what commands may do, or which computers are trusted', async () => {
    const { tools } = await computers[0]!.client.listTools();
    const names = tools.map((t) => t.name);
    for (const banned of ['set_policy', 'add_to_whitelist', 'block', 'revoke_device', 'trust_policy', 'trust_device', 'approve_device',
      'add_contact', 'invite_contact', 'accept_contact', 'remove_contact', 'block_contact']) expect(names).not.toContain(banned);
    for (const t of ['message_identity', 'contacts', 'send_message', 'inbox', 'read_message', 'reply', 'set_message_state', 'message_status']) expect(names).toContain(t);
  });

  it('`actario agent trust` refuses to run without a person at a terminal', async () => {
    const r = await promisify(execFile)(process.execPath, ['--import', 'tsx', BIN, 'agent', 'trust'], {
      env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: computers[0]!.state, HOME: computers[0]!.home, USERPROFILE: computers[0]!.home },
    }).catch((e: { code: number; stderr: string }) => e);
    expect((r as { code: number }).code).toBe(1);
    expect((r as { stderr: string }).stderr).toMatch(/needs a person at a terminal/);
  }, 30_000);

  it('the Hook\'s peek prints counts only -- never a sender\'s words, not even a line name -- and always exits 0', async () => {
    await call(0, 'send_message', { from: 'backend', to: 'frontend', kind: 'request', subject: 'Secret subject do-not-leak', body: 'body do-not-leak' });
    const run = (hook: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', BIN, 'agent', 'peek', '--hook', hook], {
      env: { ...process.env, NO_COLOR: '1', ACTARIO_HOME: computers[1]!.state, HOME: computers[1]!.home, USERPROFILE: computers[1]!.home },
    });
    const first = await run('session');
    expect(first.stdout).toMatch(/Actario: \d+ unread agent message/);
    expect(first.stdout).not.toContain('do-not-leak');
    expect(first.stdout).not.toContain('frontend');
    expect((await run('prompt')).stdout).toBe('');
  }, 30_000);
});
