import { createHash, createHmac, randomUUID } from 'node:crypto';

export const sha256 = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

export const sha256Base64 = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('base64');

/** Stable pseudonym primitive: HMAC(local_salt, normalized) truncated (6.5). */
export const hmacShort = (salt: string, value: string, len = 6): string =>
  createHmac('sha256', salt).update(value).digest('hex').slice(0, len).toUpperCase();

export const uuid = (): string => randomUUID();

/**
 * Canonical JSON for hashing. Key order must not change a hash, or every
 * idempotency key in the pipeline becomes unstable (P3).
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export const hashObject = (value: unknown): string => sha256(canonicalJson(value));

/**
 * Run-level dedupe key (arch: runs.unique(workspace_id, content_hash)).
 * Derived from content, not from ids the adapter invented, so re-capturing the
 * same session twice collapses to one row (6.1 step 9).
 */
export function runContentHash(input: {
  platform: string;
  startedAt: string | null;
  turns: { role: string; content: string }[];
}): string {
  return sha256(
    canonicalJson({
      platform: input.platform,
      started_at: input.startedAt,
      turns: input.turns.map((t) => ({ role: t.role, content: t.content })),
    }),
  );
}

export const turnContentHash = (runHash: string, idx: number, content: string): string =>
  sha256(`${runHash}:${idx}:${content}`);
