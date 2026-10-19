import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { actarioEnv } from '@distill/shared';

/**
 * Local-only secret storage (13.1).
 *
 * Two files, both under ~/.actario and neither ever uploaded:
 *   salt                 -- the pseudonym HMAC salt. Losing it means new
 *                           captures no longer link to old ones, so it is
 *                           created once and left alone.
 *   redaction_map.json.enc -- original -> pseudonym, AES-256-GCM.
 *
 * The passphrase comes from ACTARIO_PASSPHRASE when set. When it is not, the
 * key is derived from the salt file itself: that protects against a stray
 * backup or a synced folder, not against someone with the user's disk. Saying
 * so plainly here is better than implying a guarantee the design does not make.
 */
export function ensureSalt(actarioDir: string): string {
  const path = join(actarioDir, 'salt');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  mkdirSync(actarioDir, { recursive: true });
  const salt = randomBytes(32).toString('hex');
  writeFileSync(path, `${salt}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
  return salt;
}

// The scrypt salt string stays `distill:` on purpose. It is not a name the
// user ever sees -- it is baked into every redaction_map.json.enc already on
// disk, and changing it makes those files undecryptable with no error that
// would tell anyone why.
const keyFrom = (salt: string) =>
  scryptSync(actarioEnv('PASSPHRASE') ?? salt, `distill:${salt.slice(0, 16)}`, 32);

export function writeEncrypted(path: string, salt: string, data: unknown): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(salt), iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
    cipher.final(),
  ]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: body.toString('base64'),
    }),
    { mode: 0o600 },
  );
  try { chmodSync(path, 0o600); } catch { /* Windows */ }
}

export function readEncrypted<T>(path: string, salt: string): T | null {
  if (!existsSync(path)) return null;
  const env = JSON.parse(readFileSync(path, 'utf8')) as {
    iv: string; tag: string; data: string;
  };
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(salt), Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(env.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(out.toString('utf8')) as T;
}
