import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '@distill/capture';
import { HARD_PREFIXES, containsHard } from '@distill/redaction';
import { unmaskText } from '@distill/export';
import {
  DistillError, SEAL_MAGIC, SHARE_PAYLOAD_FORMAT, parseShareLink,
  type MemoryAnchor, type ShareCreate, type ShareMemoryContent, type ShareOpened, type ShareRunContent,
  type TranscriptPage, type TranscriptRun, type TranscriptSegment, type TranscriptTurn,
} from '@distill/shared';
import {
  createShareApi, getMemoryPackApi, getSealed, openShareApi, putSealed, revokeShareApi, sealShareApi, shareContentApi, type ApiOptions,
} from '../api.ts';
import {
  DATA_NOT_INSTRUCTIONS, NotLinkedError, fetchRunToCache, localReverseMap, memoryRoot, shareDirKey, writeRestored,
  type RestoredRun,
} from './restore.ts';

/**
 * Sharing, the machine side (arch v2.1 22.4-22.5; plugin 0.1.7b, CLI 0.1.5).
 *
 * A masked share needs nothing from this machine but the request: the server
 * already holds the masked run. A share that shows real values is built
 * here, because only here can the pseudonyms be reversed:
 *
 *   download the run (masked) → reverse pseudonyms with this machine's map,
 *   EXCEPT what hard rules and the user's redaction_terms produced (keys,
 *   tokens, connection strings, card numbers, the words they listed) →
 *   AES-256-GCM with a fresh random key → upload the ciphertext → the key
 *   goes into the link's #k= fragment and nowhere else.
 *
 * The platform stores a file it cannot open. The link is the key, which is
 * why such a share may only go to the organization or named people: the
 * server checks who is asking, the key decides what they can read.
 *
 * Opening is the mirror image: a masked share is paged down like a restore;
 * a sealed one is downloaded and decrypted here with the key from the link.
 * Either way it lands in ~/.actario/restore/ and comes back through the same
 * answer as fetch_run, marked as someone else's conversation.
 */

// ── sealing ──

export interface SealedFile { bytes: Buffer; key: Buffer; sha256: string }

export function seal(payload: unknown): SealedFile {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final(), c.getAuthTag()]);
  const bytes = Buffer.concat([Buffer.from(SEAL_MAGIC, 'ascii'), iv, body]);
  return { bytes, key, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function unseal(bytes: Buffer, key: Buffer): unknown {
  const magic = bytes.subarray(0, SEAL_MAGIC.length).toString('ascii');
  if (magic !== SEAL_MAGIC || bytes.length < SEAL_MAGIC.length + 12 + 16) {
    throw new DistillError('invalid_request', 'This is not a sealed Actario share file.');
  }
  const iv = bytes.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + 12);
  const rest = bytes.subarray(SEAL_MAGIC.length + 12);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(rest.subarray(rest.length - 16));
  try {
    const plain = Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new DistillError('invalid_request', 'The key in the link does not open this share (a mistyped or cut-off link?).');
  }
}

/**
 * This machine's reverse map, without what hard rules and redaction_terms
 * produced -- those never come back, not even in a share -- and without any
 * soft original that CONTAINS such a thing (an email at a listed client's
 * domain, a path under a listed project name): the longer soft match won at
 * capture, but the value inside it is still one that is never shown.
 */
export function revealMap(terms: string[] = readConfig().redaction_terms): Map<string, string> | null {
  const all = localReverseMap();
  if (!all) return null;
  const out = new Map<string, string>();
  for (const [pseudo, orig] of all) {
    const prefix = pseudo.slice(0, pseudo.indexOf('-'));
    if (HARD_PREFIXES.has(prefix) || containsHard(orig, terms)) continue;
    out.set(pseudo, orig);
  }
  return out;
}

export interface SharePayloadRun {
  format: typeof SHARE_PAYLOAD_FORMAT;
  object: 'run';
  run: Pick<TranscriptRun, 'run_hash' | 'title' | 'platform' | 'model' | 'started_at' | 'ended_at' | 'turns'>;
  turns: TranscriptTurn[];
  segments: TranscriptSegment[];
  page: TranscriptPage | null;
}
export interface SharePayloadMemory {
  format: typeof SHARE_PAYLOAD_FORMAT;
  object: 'memory';
  title: string;
  body: string;
  anchors: MemoryAnchor[];
}

/** Reverses what `reverse` knows in every text of a run; counts what stayed (captured elsewhere, or hard). */
export function revealRun(r: RestoredRun, reverse: Map<string, string>): { payload: SharePayloadRun; replaced: number; stayed: number } {
  let replaced = 0;
  let stayed = 0;
  const u = (t: string | null): string | null => {
    if (t == null) return t;
    const x = unmaskText(t, reverse);
    replaced += Object.values(x.report.replaced).reduce((a, b) => a + b, 0);
    stayed += x.report.unknown;
    return x.text;
  };
  const run = r.meta.run;
  return {
    payload: {
      format: SHARE_PAYLOAD_FORMAT, object: 'run',
      run: { run_hash: run.run_hash, title: u(run.title), platform: run.platform, model: run.model, started_at: run.started_at, ended_at: run.ended_at, turns: run.turns },
      turns: r.turns.map((t) => ({ ...t, content: u(t.content) ?? '', tool_result: u(t.tool_result) })),
      segments: r.segments.map((s) => ({ ...s, topic: u(s.topic), summary: u(s.summary), labels: s.labels.map((l) => u(l) ?? l) })),
      page: r.page ? {
        ...r.page, title: u(r.page.title) ?? r.page.title, summary: u(r.page.summary),
        sections: r.page.sections.map((s) => ({ ...s, heading: u(s.heading) ?? s.heading, body: u(s.body) ?? s.body })),
      } : null,
    },
    replaced, stayed,
  };
}

// ── create ──

export interface CreateShareInput {
  object: { type: 'run'; run: string } | { type: 'memory'; pack_id: string; version?: number };
  audience: 'link' | 'org' | 'users';
  recipients?: string[];
  permissions?: ('view' | 'restore' | 'fork')[];
  expires_in_days?: number;
  reveal?: boolean;
  web_view?: boolean;
}

export async function createShare(api: ApiOptions, input: CreateShareInput) {
  const body: ShareCreate = {
    object: input.object, audience: input.audience,
    ...(input.recipients ? { recipients: input.recipients } : {}),
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.expires_in_days ? { expires_in_days: input.expires_in_days } : {}),
    reveal: input.reveal ?? false,
    ...(input.web_view !== undefined ? { web_view: input.web_view } : {}),
  };
  if (!input.reveal) {
    const created = await createShareApi(api, body);
    return { share_id: created.share_id, url: created.url, expires_at: created.expires_at, revealed: false as const };
  }

  // Real values: build and seal the content here first, so nothing is
  // created on the server if this machine cannot do it.
  const reverse = revealMap();
  if (!reverse) {
    throw new DistillError('forbidden',
      'Real values can only be shown from the machine that captured the conversation: this one has no redaction map. Share the masked version, or run this on that machine.');
  }
  let payload: SharePayloadRun | SharePayloadMemory;
  let replaced = 0;
  let stayed = 0;
  if (input.object.type === 'run') {
    const r = await fetchRunToCache(api, input.object.run);
    const out = revealRun(r, reverse);
    payload = out.payload;
    replaced = out.replaced;
    stayed = out.stayed;
    body.object = { type: 'run', run: r.meta.run.run_hash };
  } else {
    // The uploaded version, never a local draft: the share row names a server
    // version, and what is sealed must be exactly that.
    const m = await getMemoryPackApi(api, input.object.pack_id, input.object.version);
    const x = unmaskText(m.shown.body, reverse);
    replaced = Object.values(x.report.replaced).reduce((a, b) => a + b, 0);
    stayed = x.report.unknown;
    payload = { format: SHARE_PAYLOAD_FORMAT, object: 'memory', title: m.pack.title, body: x.text, anchors: m.shown.anchors };
    body.object = { type: 'memory', pack_id: m.pack.id, version: m.shown.version };
  }
  const sealed = seal(payload);

  const created = await createShareApi(api, body);
  try {
    if (!created.upload) throw new DistillError('internal', 'The server did not issue an upload for the sealed file.', undefined, 502);
    await putSealed(created.upload.signed_url, sealed.bytes);
    await sealShareApi(api, created.share_id, sealed.sha256);
  } catch (e) {
    // Leave nothing half-made: a share that can never be opened is revoked.
    await revokeShareApi(api, created.share_id).catch(() => undefined);
    throw e;
  }
  return {
    share_id: created.share_id,
    url: `${created.url}#k=${sealed.key.toString('base64url')}`,
    expires_at: created.expires_at,
    revealed: true as const,
    values_shown: replaced,
    values_still_masked: stayed,
  };
}

// ── open ──

const ZERO = '00000000-0000-4000-8000-000000000000';

export type OpenedShare =
  | { kind: 'run'; restored: RestoredRun; opened: ShareOpened }
  | { kind: 'memory'; opened: ShareOpened; title: string; body: string; path: string };

/**
 * Opens a share link into this machine: `restore` when the share allows it,
 * else `open`. A sealed share needs the #k= key from the link.
 */
export async function openShare(api: ApiOptions | null, link: string): Promise<OpenedShare> {
  const parsed = parseShareLink(link);
  if (!parsed) throw new DistillError('invalid_request', 'That is not an Actario share link (…/s/<token>).');
  if (!api) throw new NotLinkedError('Opening a share needs this machine linked to an Actario account (the share checks who you are). Call `link` first.');

  let opened: ShareOpened;
  try {
    opened = await openShareApi(api, parsed.token, 'restore');
  } catch (e) {
    if (!(e instanceof DistillError) || e.code !== 'forbidden') throw e;
    throw new DistillError('forbidden', 'This share can be viewed on the web, not brought into a conversation: its owner did not allow restore.', undefined, 403);
  }
  const by = opened.shared_by?.name ?? opened.shared_by?.email ?? null;
  const source = { kind: 'share' as const, api_url: api.baseUrl, share_id: opened.share_id, title: opened.title, shared_by: by, revealed: opened.revealed };

  let run: SharePayloadRun | null = null;
  let memory: { title: string; body: string } | null = null;
  if (opened.revealed) {
    if (!parsed.key) throw new DistillError('invalid_request', 'This share shows real values and needs its key: the part of the link after #k= is missing. Ask for the whole link.');
    if (!opened.download) throw new DistillError('not_found', 'The sealed file is not available.');
    const bytes = await getSealed(opened.download.url);
    if (opened.download.sha256 && createHash('sha256').update(bytes).digest('hex') !== opened.download.sha256) {
      throw new DistillError('invalid_request', 'The sealed file does not match what the sharer uploaded.');
    }
    const payload = unseal(bytes, Buffer.from(parsed.key, 'base64url')) as SharePayloadRun | SharePayloadMemory;
    if (payload.object === 'run') run = payload;
    else memory = { title: payload.title, body: payload.body };
  } else if (opened.object_type === 'run') {
    const first = await shareContentApi<ShareRunContent>(api, parsed.token, 0, 500);
    const turns = [...first.turns];
    let next = first.next_from;
    for (let i = 0; next !== null && i < 200; i++) {
      const page = await shareContentApi<ShareRunContent>(api, parsed.token, next, 500);
      turns.push(...page.turns);
      next = page.next_from;
    }
    const o = (opened.object ?? {}) as { run_hash?: string; platform?: string; model?: string | null; started_at?: string; ended_at?: string | null; turns?: number };
    run = {
      format: SHARE_PAYLOAD_FORMAT, object: 'run',
      run: { run_hash: o.run_hash ?? opened.share_id, title: opened.title, platform: o.platform ?? 'unknown', model: o.model ?? null,
        started_at: new Date(o.started_at ?? Date.now()).toISOString(), ended_at: o.ended_at ? new Date(o.ended_at).toISOString() : null, turns: o.turns ?? turns.length },
      turns, segments: first.segments ?? [], page: first.page ?? null,
    };
  } else {
    const c = await shareContentApi<ShareMemoryContent>(api, parsed.token);
    memory = { title: opened.title, body: c.body };
  }

  if (run) {
    const restored = writeRestored({
      run: { ...run.run, id: ZERO, outcome: null, agent: null, workspace_id: ZERO },
      turns: run.turns, segments: run.segments, page: run.page, artifacts: [], source, dirKey: shareDirKey(parsed.token),
    });
    return { kind: 'run', restored, opened };
  }
  const dir = join(memoryRoot(), `shared-${opened.share_id}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'memory.md');
  writeFileSync(path, memory!.body, 'utf8');
  writeFileSync(join(dir, 'share.json'), `${JSON.stringify({ ...source, opened_at: new Date().toISOString() }, null, 2)}\n`);
  return { kind: 'memory', opened, title: memory!.title, body: memory!.body, path };
}

export const SHARED_NOTE = DATA_NOT_INSTRUCTIONS;
