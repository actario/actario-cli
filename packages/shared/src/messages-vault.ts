import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { DistillError } from './errors.ts';
import { MESSAGE_FORMAT_V2, zMessageBody, type MessageBody, type MessageKind } from './contracts/messages.ts';

/**
 * `actario.msg/v2` -- a message body kept by Actario (plan ch. 29, arch
 * ch. 37; replaces decision #67 for new messages).
 *
 * The sending computer masks the body (hard rules + redaction_terms) and
 * sends it over TLS; the API route seals it here, under a server key, before
 * the row is written, and opens it again for the people allowed to read the
 * row. So the database never holds a body in the clear, and a dump of it
 * opens nothing without the key -- but Actario itself can read every v2
 * body. That is the point of v2 (the web Messages page shows them) and it is
 * disclosed as such.
 *
 * Stored form: `v2.<key id>.<iv b64u>.<ciphertext||tag b64u>`. AES-256-GCM,
 * the AAD binds the body to its routing (format, client_msg_id, from, to,
 * kind), so a body cannot be moved onto another row.
 *
 * Keys: `ACTARIO_MESSAGES_KEY` = `<id>:<32 bytes base64url>` (the current
 * one, used to seal), `ACTARIO_MESSAGES_KEYS_OLD` = the same, comma
 * separated (still opened, never used to seal). Rotating = new current,
 * old one moved to _OLD.
 */

export interface VaultKey { id: string; key: Buffer }
export interface Vault { current: VaultKey | null; all: Map<string, Buffer> }
export interface VaultRouting { client_msg_id: string; from: string; to: string; kind: MessageKind }

const b64u = (b: Buffer): string => b.toString('base64url');
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
export const SEALED_BODY = /^v2\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

function parseKey(s: string): VaultKey {
  const i = s.indexOf(':');
  const id = i > 0 ? s.slice(0, i).trim() : 'k1';
  const raw = (i > 0 ? s.slice(i + 1) : s).trim();
  const key = Buffer.from(raw, 'base64url');
  if (!KEY_ID.test(id) || key.length !== 32) {
    throw new DistillError('internal', 'ACTARIO_MESSAGES_KEY must be <id>:<32 bytes, base64url> (id: letters, digits, - or _, at most 16).', undefined, 500);
  }
  return { id, key };
}

/** Reads the keys from an env-shaped object. No current key: nothing can be sealed (sending v2 is 503), old rows still open. */
export function vaultFrom(env: { ACTARIO_MESSAGES_KEY?: string | undefined; ACTARIO_MESSAGES_KEYS_OLD?: string | undefined }): Vault {
  const all = new Map<string, Buffer>();
  const current = env.ACTARIO_MESSAGES_KEY?.trim() ? parseKey(env.ACTARIO_MESSAGES_KEY) : null;
  for (const s of (env.ACTARIO_MESSAGES_KEYS_OLD ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const k = parseKey(s);
    all.set(k.id, k.key);
  }
  if (current) all.set(current.id, current.key);
  return { current, all };
}

/** A fresh key in the env form, for setup (`node -e` in the deploy notes). */
export const newVaultKey = (id = 'k1'): string => `${id}:${b64u(randomBytes(32))}`;

const aadOf = (r: VaultRouting): Buffer =>
  createHash('sha256').update(JSON.stringify([MESSAGE_FORMAT_V2, r.client_msg_id, r.from.toLowerCase(), r.to.toLowerCase(), r.kind])).digest();

/** The body as stored and hashed: the parsed contract, key order fixed by zod. */
export const canonicalBody = (body: MessageBody): string => JSON.stringify(zMessageBody.parse(body));

/**
 * What idempotency compares: the same client_msg_id with another body is a
 * conflict. Keyed (HMAC under a key derived from the current server key) so
 * the hash, which outlives the body, cannot confirm a guessed short body
 * from a database dump.
 */
export function bodyHash(v: Vault, body: MessageBody): string {
  if (!v.current) throw new DistillError('messages_unavailable', 'Agent messages are not configured on this server (ACTARIO_MESSAGES_KEY is missing).', undefined, 503);
  const k = Buffer.from(hkdfSync('sha256', v.current.key, Buffer.alloc(0), Buffer.from(`${MESSAGE_FORMAT_V2} body-hash`, 'utf8'), 32));
  return createHmac('sha256', k).update(canonicalBody(body)).digest('hex');
}

export function sealBody(v: Vault, r: VaultRouting, body: MessageBody): { sealed: string; key_id: string; size_bytes: number; body_sha256: string } {
  if (!v.current) {
    throw new DistillError('messages_unavailable', 'Agent messages are not configured on this server (ACTARIO_MESSAGES_KEY is missing).', undefined, 503);
  }
  const plain = Buffer.from(canonicalBody(body), 'utf8');
  if (plain.length > 65_536) throw new DistillError('invalid_request', 'A message body is at most 64 KB. Send something bigger as a handoff (a share link).', undefined, 422);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', v.current.key, iv);
  c.setAAD(aadOf(r));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { sealed: `v2.${v.current.id}.${b64u(iv)}.${b64u(ct)}`, key_id: v.current.id, size_bytes: plain.length, body_sha256: bodyHash(v, body) };
}

/** Opens a stored body. Throws `body_unreadable` when the key is gone or the body does not belong to this routing. */
export function openBody(v: Vault, r: VaultRouting, sealed: string): MessageBody {
  if (!SEALED_BODY.test(sealed)) throw new DistillError('body_unreadable', 'This message body is not in the v2 form.', undefined, 500);
  const [, id, ivS, ctS] = sealed.split('.') as [string, string, string, string];
  const key = v.all.get(id);
  if (!key) throw new DistillError('body_unreadable', `This message was sealed with key "${id}", which this server no longer has.`, undefined, 500);
  try {
    const ct = Buffer.from(ctS, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivS, 'base64url'));
    d.setAAD(aadOf(r));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return zMessageBody.parse(JSON.parse(plain.toString('utf8')));
  } catch {
    throw new DistillError('body_unreadable', 'This message body could not be opened (damaged, or not this message\'s).', undefined, 500);
  }
}
