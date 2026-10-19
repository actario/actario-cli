import { z } from 'zod';
import { zIso, zUuid } from './common.ts';
import {
  zMemoryAnchor, zTranscriptArtifact, zTranscriptPage, zTranscriptSegment, zTranscriptTurn,
} from './restore.ts';

/**
 * Shares (arch v2.1 22.4-22.5, plugin 0.1.7b, CLI 0.1.5).
 *
 * A person shares a run (masked turns, segments, the current note page) or a
 * version of their memory pack. The link is `https://<host>/s/<token>`; the
 * server keeps only sha256(token). A share that shows real values is sealed
 * on the sharer's machine: AES-256-GCM, key in the link's `#k=` fragment --
 * a part of a URL no browser or HTTP client sends to a server -- so the
 * platform stores ciphertext it cannot open.
 *
 * Defaults (plan open #27, settled 10-08 as the plan leaned): signed-in only,
 * 30 days, view + restore (fork is opt-in), masked; real values only to the
 * organization or named people; an org admin can limit sharing.
 */

export const zShareAudience = z.enum(['link', 'org', 'users']);
export type ShareAudience = z.infer<typeof zShareAudience>;
export const zSharePermission = z.enum(['view', 'restore', 'fork']);
export type SharePermission = z.infer<typeof zSharePermission>;

export const zShareCreate = z.object({
  object: z.discriminatedUnion('type', [
    /** A run id, run URL, or run_hash (12+ characters). */
    z.object({ type: z.literal('run'), run: z.string().min(8).max(300) }),
    z.object({ type: z.literal('memory'), pack_id: zUuid, version: z.number().int().positive().optional() }),
  ]),
  audience: zShareAudience,
  recipients: z.array(z.string().trim().toLowerCase().email()).max(50).optional(),
  permissions: z.array(zSharePermission).min(1).max(3).default(['view', 'restore']),
  expires_in_days: z.number().int().min(1).max(90).default(30),
  /** Show real values: the request then returns an upload URL for the sealed file. */
  reveal: z.boolean().default(false),
  /** Revealed shares only: false = the plugin may restore it, no decryption in a browser. */
  web_view: z.boolean().default(true),
  open_limit: z.number().int().min(1).max(10000).default(200),
  title: z.string().trim().min(1).max(200).optional(),
}).superRefine((v, ctx) => {
  if (v.reveal && v.audience === 'link') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audience'], message: 'a share that shows real values goes to the organization or named people, never to anyone with the link' });
  }
  if (v.audience === 'users' && (!v.recipients || v.recipients.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients'], message: 'name at least one person by email' });
  }
  if (v.audience !== 'users' && v.recipients && v.recipients.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients'], message: 'recipients are for audience "users" only' });
  }
  if (v.permissions.includes('fork') && (v.reveal || v.object.type !== 'run')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permissions'], message: 'fork is for shares of a run with masked values only' });
  }
});
export type ShareCreate = z.input<typeof zShareCreate>;

export const zShareCreated = z.object({
  share_id: zUuid,
  /** Shown once. The server keeps only its hash. */
  token: z.string(),
  /** https://<host>/s/<token> -- without #k=; the sharer's machine appends the key. */
  url: z.string().url(),
  expires_at: zIso,
  /** Revealed shares: where to PUT the sealed file, then POST /shares/{id}/sealed. */
  upload: z.object({ signed_url: z.string().url(), path: z.string() }).nullable(),
});
export type ShareCreated = z.infer<typeof zShareCreated>;

export const zShareOpened = z.object({
  share_id: zUuid,
  object_type: z.enum(['run', 'memory']),
  title: z.string(),
  permissions: z.array(zSharePermission),
  audience: zShareAudience,
  revealed: z.boolean(),
  web_view: z.boolean(),
  expires_at: zIso,
  shared_by: z.object({ email: z.string().nullable(), name: z.string().nullable() }).nullable(),
  is_owner: z.boolean(),
  object: z.record(z.unknown()).nullable(),
  /** Revealed shares: a short-lived URL for the sealed file, and its sha256. */
  download: z.object({ url: z.string().url(), sha256: z.string().nullable() }).nullable(),
});
export type ShareOpened = z.infer<typeof zShareOpened>;

export const zShareRunContent = z.object({
  turns: z.array(zTranscriptTurn),
  next_from: z.number().int().nullable(),
  segments: z.array(zTranscriptSegment).optional(),
  page: zTranscriptPage.nullable().optional(),
  artifacts: z.array(zTranscriptArtifact).optional(),
});
export type ShareRunContent = z.infer<typeof zShareRunContent>;

export const zShareMemoryContent = z.object({
  body: z.string(),
  anchors: z.array(zMemoryAnchor),
  version: z.number().int(),
  as_of: zIso,
  budget: z.enum(['S', 'M', 'L']),
});
export type ShareMemoryContent = z.infer<typeof zShareMemoryContent>;

export const zShareListItem = z.object({
  id: zUuid,
  object_type: z.enum(['run', 'memory']),
  run_id: zUuid.nullable(),
  pack_id: zUuid.nullable(),
  title: z.string(),
  audience: zShareAudience,
  recipients: z.array(z.string()),
  permissions: z.array(zSharePermission),
  revealed: z.boolean(),
  sealed: z.boolean(),
  opens: z.number().int(),
  open_limit: z.number().int(),
  expires_at: zIso,
  revoked_at: zIso.nullable(),
  created_at: zIso,
  events: z.object({ open: z.number().int(), restore: z.number().int(), fork: z.number().int() }),
  status: z.enum(['live', 'expired', 'revoked', 'unsealed']),
});
export type ShareListItem = z.infer<typeof zShareListItem>;

// ── links ──

/** 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-]. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isShareToken = (s: string): boolean => TOKEN_RE.test(s);

/**
 * `https://host/s/<token>#k=<key>` → its parts. The key is the 32-byte
 * AES key, base64url, present only on links that show real values. Null for
 * anything that is not a share link.
 */
export function parseShareLink(input: string): { origin: string | null; token: string; key: string | null } | null {
  const s = input.trim();
  if (isShareToken(s)) return { origin: null, token: s, key: null };
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const m = /\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(u.pathname);
  if (!m) return null;
  const k = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(u.hash);
  return { origin: u.origin, token: m[1]!, key: k ? k[1]! : null };
}

/**
 * The sealed file: "ACTS1" (5 bytes) | iv (12) | ciphertext | GCM tag (16).
 * Ciphertext||tag is what WebCrypto's AES-GCM decrypt takes, so the web page
 * and the CLI read the same bytes. The plaintext is UTF-8 JSON
 * (`actario.share/v1`).
 */
export const SEAL_MAGIC = 'ACTS1';
export const SHARE_PAYLOAD_FORMAT = 'actario.share/v1' as const;
