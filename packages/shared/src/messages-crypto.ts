import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, sign, verify, type KeyObject,
} from 'node:crypto';
import { DistillError } from './errors.ts';
import {
  MESSAGE_FORMAT, zMessageBody,
  type MessageBody, type MessageEnvelope, type MessageKind, type WrappedKey,
} from './contracts/messages.ts';

/**
 * `actario.msg/v1` -- how an agent message is sealed, signed, checked and
 * opened (arch v3.0 24.7, 24.15). Node's crypto only: no dependency, and the
 * same code runs in the CLI (seal, open) and the API route (verify).
 *
 * Seal, on the sending machine:
 *   1. content key K (32 random bytes); body = AES-256-GCM(K, iv, JSON,
 *      aad = sha256 of the routing header) -- the ciphertext cannot be moved
 *      onto another envelope;
 *   2. one ephemeral X25519 pair per message; for each recipient device d:
 *      kek_d = HKDF-SHA256(X25519(e, d), salt = e_pub || d_pub,
 *      info = "actario.msg/v1 key-wrap"), wrapped_d = AES-256-GCM(kek_d, K);
 *   3. the sending device signs (Ed25519) a canonical JSON of the routing,
 *      the time, the ephemeral key, every wrapped key and sha256(ciphertext).
 *
 * The platform stores all of it and holds no private key: it can check the
 * signature (and does, before storing) but cannot open anything.
 */

export interface DevicePrivateKeys {
  /** JWK `d` values, base64url. */
  x25519_d: string;
  ed25519_d: string;
  x25519_pub: string;
  ed25519_pub: string;
}

export interface PublicDevice { id: string; x25519_pub: string; ed25519_pub: string }

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

export function generateDeviceKeys(): DevicePrivateKeys {
  const x = generateKeyPairSync('x25519');
  const e = generateKeyPairSync('ed25519');
  const xj = x.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const ej = e.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { x25519_d: xj.d, x25519_pub: xj.x, ed25519_d: ej.d, ed25519_pub: ej.x };
}

const xPub = (x: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
const xPriv = (k: DevicePrivateKeys): KeyObject => createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: k.x25519_pub, d: k.x25519_d }, format: 'jwk' });
const edPub = (x: string): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const edPriv = (k: DevicePrivateKeys): KeyObject => createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.ed25519_pub, d: k.ed25519_d }, format: 'jwk' });

/** 40 hex: sha256(ed25519_pub || x25519_pub), first 20 bytes. */
export function deviceFingerprint(pub: { x25519_pub: string; ed25519_pub: string }): string {
  return sha256(Buffer.concat([unb64u(pub.ed25519_pub), unb64u(pub.x25519_pub)])).subarray(0, 20).toString('hex');
}

/** How a person reads a fingerprint aloud: 8 groups of 5 digits. */
export function safetyNumber(fingerprints: string[]): string {
  const digest = sha256([...fingerprints].sort().join(','));
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(String(digest.readUInt32BE(i * 4) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

// ── devices: proof of possession and endorsements (24.15) ──

/** What a device signs when it registers: this person, these keys. */
export const registrationBytes = (userId: string, pub: { x25519_pub: string; ed25519_pub: string }): Buffer =>
  Buffer.from(JSON.stringify(['actario.device-register/v1', userId, pub.x25519_pub, pub.ed25519_pub]), 'utf8');

/** What an approved device signs to approve another of the same person's. */
export const endorsementBytes = (userId: string, d: { id: string; x25519_pub: string; ed25519_pub: string }): Buffer =>
  Buffer.from(JSON.stringify(['actario.device/v1', userId, d.id, d.x25519_pub, d.ed25519_pub]), 'utf8');

export const signWith = (keys: DevicePrivateKeys, bytes: Buffer): string => b64u(sign(null, bytes, edPriv(keys)));

export function verifyWith(ed25519Pub: string, bytes: Buffer, signature: string): boolean {
  try { return verify(null, bytes, edPub(ed25519Pub), unb64u(signature)); } catch { return false; }
}

/** What the signature covers. Field order is fixed here, not by the caller. */
export interface SignedFields {
  client_msg_id: string;
  from: string;
  to: string;
  kind: MessageKind;
  in_reply_to: string | null;
  sent_at: string;
  sender_device: string;
  envelope: MessageEnvelope;
  ciphertext_sha256: string;
  size_bytes: number;
}

export function signingBytes(f: SignedFields): Buffer {
  const keys = [...f.envelope.keys].sort((a, b) => a.device.localeCompare(b.device)).map((k) => [k.device, k.iv, k.wrapped]);
  return Buffer.from(JSON.stringify([
    MESSAGE_FORMAT, f.client_msg_id, f.from.toLowerCase(), f.to.toLowerCase(), f.kind, f.in_reply_to ?? null,
    f.sent_at, f.sender_device, f.envelope.ephemeral_pub, f.envelope.iv, keys, f.ciphertext_sha256, f.size_bytes,
  ]), 'utf8');
}

const aadOf = (f: { client_msg_id: string; from: string; to: string; kind: string }): Buffer =>
  sha256(JSON.stringify([MESSAGE_FORMAT, f.client_msg_id, f.from.toLowerCase(), f.to.toLowerCase(), f.kind]));

const WRAP_INFO = Buffer.from(`${MESSAGE_FORMAT} key-wrap`, 'utf8');
const kekFor = (shared: Buffer, ePub: string, dPub: string): Buffer =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([unb64u(ePub), unb64u(dPub)]), WRAP_INFO, 32));

function gcm(key: Buffer, iv: Buffer, plain: Buffer, aad?: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function ungcm(key: Buffer, iv: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

export interface SealInput {
  client_msg_id: string;
  from: string;
  to: string;
  kind: MessageKind;
  in_reply_to?: string | null;
  sent_at?: string;
  body: MessageBody;
  sender: { device_id: string; keys: DevicePrivateKeys };
  /** Every device the content key is wrapped for (the recipient's, plus the sender's own). */
  devices: PublicDevice[];
}

export interface Sealed extends SignedFields { ciphertext: string; signature: string }

export function sealMessage(i: SealInput): Sealed {
  const body = zMessageBody.parse(i.body);
  const plain = Buffer.from(JSON.stringify(body), 'utf8');
  if (plain.length > 65_536) throw new DistillError('invalid_request', 'A message body is at most 64 KB. Send something bigger as a handoff (a share link).');
  const seen = new Set<string>();
  const devices = i.devices.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  if (devices.length === 0) throw new DistillError('invalid_request', 'No device to seal the message for.');

  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const routing = { client_msg_id: i.client_msg_id, from: i.from, to: i.to, kind: i.kind };
  const ciphertext = gcm(contentKey, iv, plain, aadOf(routing));

  const eph = generateKeyPairSync('x25519');
  const ePub = (eph.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const keys: WrappedKey[] = devices.map((d) => {
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: xPub(d.x25519_pub) });
    const wiv = randomBytes(12);
    return { device: d.id, iv: b64u(wiv), wrapped: b64u(gcm(kekFor(shared, ePub, d.x25519_pub), wiv, contentKey)) };
  });

  const fields: SignedFields = {
    ...routing,
    in_reply_to: i.in_reply_to ?? null,
    sent_at: i.sent_at ?? new Date().toISOString(),
    sender_device: i.sender.device_id,
    envelope: { v: MESSAGE_FORMAT, ephemeral_pub: ePub, iv: b64u(iv), keys },
    ciphertext_sha256: sha256(ciphertext).toString('hex'),
    size_bytes: plain.length,
  };
  const signature = b64u(sign(null, signingBytes(fields), edPriv(i.sender.keys)));
  return { ...fields, ciphertext: b64u(ciphertext), signature };
}

/**
 * The check both sides make: the signature is the sending device's over
 * exactly these fields, and the ciphertext is the one it signed. The server
 * runs it before storing; the recipient again, against the key it pinned.
 */
export function verifyMessage(f: SignedFields & { ciphertext: string | null; signature: string }, senderEd25519Pub: string): boolean {
  if (f.ciphertext !== null && sha256(unb64u(f.ciphertext)).toString('hex') !== f.ciphertext_sha256) return false;
  try {
    return verify(null, signingBytes(f), edPub(senderEd25519Pub), unb64u(f.signature));
  } catch {
    return false;
  }
}

/** Opens a verified message with this device's keys. Throws if this device has no key in it. */
export function openMessage(
  f: SignedFields & { ciphertext: string | null },
  me: { device_id: string; keys: DevicePrivateKeys },
): MessageBody {
  if (f.ciphertext === null) throw new DistillError('not_found', 'This message\'s body was deleted (bodies are kept 30 days; the envelope stays).');
  const mine = f.envelope.keys.find((k) => k.device === me.device_id);
  if (!mine) {
    throw new DistillError('forbidden',
      'This message was not sealed for this computer: it was sent before this computer\'s key was registered, or to another device only.');
  }
  try {
    const shared = diffieHellman({ privateKey: xPriv(me.keys), publicKey: xPub(f.envelope.ephemeral_pub) });
    const contentKey = ungcm(kekFor(shared, f.envelope.ephemeral_pub, me.keys.x25519_pub), unb64u(mine.iv), unb64u(mine.wrapped));
    const plain = ungcm(contentKey, unb64u(f.envelope.iv), unb64u(f.ciphertext), aadOf(f));
    return zMessageBody.parse(JSON.parse(plain.toString('utf8')));
  } catch (e) {
    if (e instanceof DistillError) throw e;
    throw new DistillError('invalid_request', 'This message could not be opened with this computer\'s key (damaged, or not for this device).');
  }
}
