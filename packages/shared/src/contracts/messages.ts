import { z } from 'zod';
import { zUuid } from './common.ts';

/**
 * Agent messages, first cut: T0 -- a person's own agents (arch v3.0 ch. 24,
 * 24.15; plan #66–#69; CLI/plugin 0.2.0 preview).
 *
 * Two formats live side by side (plan ch. 29, arch ch. 37):
 *   - `actario.msg/v1` (0.2.0–0.2.6): sealed end to end on the sending
 *     machine (messages-crypto.ts) for every device of the recipient. The
 *     platform cannot open these; they are read in an agent only.
 *   - `actario.msg/v2` (0.2.7 on): the sender masks the body and sends it;
 *     the API seals it under a server key (messages-vault.ts) and opens it
 *     for whoever may read the row -- the person, on the web Messages page
 *     and in their agents, and the platform superuser. No device keys, no
 *     computer approval.
 */

export const MESSAGE_FORMAT = 'actario.msg/v1' as const;
export const MESSAGE_FORMAT_V2 = 'actario.msg/v2' as const;
export const MESSAGE_MAX_BYTES = 65_536;

export const zMessageKind = z.enum(['note', 'request', 'command', 'handoff', 'reply', 'result']);
export type MessageKind = z.infer<typeof zMessageKind>;

export const zMessageState = z.enum([
  'submitted', 'delivered', 'read', 'working', 'input_required', 'completed', 'failed', 'rejected', 'expired', 'canceled',
]);
export type MessageState = z.infer<typeof zMessageState>;

/** What the recipient's side can set (the sender can only cancel). */
export const zMessageStateChange = z.object({
  state: z.enum(['read', 'working', 'input_required', 'completed', 'failed', 'rejected', 'canceled']),
  note: z.string().trim().max(500).optional(),
});
export type MessageStateChange = z.infer<typeof zMessageStateChange>;

/** The capability labels a command asks for (24.3). `external` always needs a person. */
export const zCapability = z.enum(['read', 'run_tests', 'edit', 'vcs_local', 'external']);
export type Capability = z.infer<typeof zCapability>;

const zB64u32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url');
const zB64u = z.string().regex(/^[A-Za-z0-9_-]*$/, 'base64url');

/**
 * A line's name as an address (migration 20261025003000, app.endpoint_slug):
 * ASCII as before -- anything but a-z 0-9 . _ - becomes "-" -- and every
 * non-ASCII character kept, so an Acta line called 網站文案 is
 * `<handle>/網站文案`. "" when nothing is left.
 */
export const endpointSlug = (s: string): string =>
  s.toLowerCase().replace(/[\x00-\x2c\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7f\s\u3000]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

/** `<handle>/<agent>` or a personal `<handle>`. The agent part: a slug (endpointSlug), not starting with . or _. */
export const zAddress = z.string().trim().toLowerCase().min(3).max(100)
  .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9](\/(?:[a-z0-9]|[^\x00-\x7f\s])(?:[a-z0-9._-]|[^\x00-\x7f\s]){0,62})?$/u, 'an address is <handle> or <handle>/<agent>');

export const zWrappedKey = z.object({ device: zUuid, iv: zB64u.length(16), wrapped: zB64u.min(40).max(80) });
export type WrappedKey = z.infer<typeof zWrappedKey>;

export const zMessageEnvelope = z.object({
  v: z.literal(MESSAGE_FORMAT),
  ephemeral_pub: zB64u32,
  iv: zB64u.length(16),
  keys: z.array(zWrappedKey).min(1).max(40),
});
export type MessageEnvelope = z.infer<typeof zMessageEnvelope>;

/** POST /api/v1/messages */
export const zMessageSend = z.object({
  client_msg_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  from: zAddress,
  to: zAddress,
  kind: zMessageKind,
  in_reply_to: zUuid.nullable().default(null),
  /** Exactly Date#toISOString(): the form the server stores and hands back, so the signature verifies on every receiver. */
  sent_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'sent_at is new Date().toISOString()'),
  sender_device: zUuid,
  envelope: zMessageEnvelope,
  ciphertext: zB64u.min(22).max(120_000),
  ciphertext_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  size_bytes: z.number().int().min(1).max(MESSAGE_MAX_BYTES),
  workspace_id: zUuid.optional(),
});
export type MessageSend = z.input<typeof zMessageSend>;
export type MessageSendParsed = z.infer<typeof zMessageSend>;

/**
 * POST /api/v1/messages, v2: the body itself (masked on the sending
 * machine), sealed by the route. From a browser anything, from any of the
 * person's lines (20261025003000); a result only from the line the command
 * was sent to.
 *
 * Threads: an answer (`in_reply_to`) stays on its message's thread. Anything
 * else continues `thread` when given; an agent's message with neither
 * continues the latest thread between the same two lines from the last 12
 * hours unless `new_thread` is set (the web page never continues on its own).
 */
export const zMessageSendV2 = z.object({
  format: z.literal('v2'),
  client_msg_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  from: zAddress,
  to: zAddress,
  kind: zMessageKind,
  in_reply_to: zUuid.nullable().default(null),
  /** Continue this thread (on its latest message). */
  thread: zUuid.optional(),
  /** Start a new thread even when a recent one between these two lines exists. */
  new_thread: z.boolean().optional(),
  body: z.lazy(() => zMessageBody),
  /** The sending computer's label ("win-931af8"): shown beside the message, never a hostname. */
  source: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._ -]+$/).optional(),
  workspace_id: zUuid.optional(),
});
export type MessageSendV2 = z.input<typeof zMessageSendV2>;
export type MessageSendV2Parsed = z.infer<typeof zMessageSendV2>;

export interface MessageSent {
  message_id: string;
  thread_id: string;
  state: MessageState;
  created: boolean;
  to_address: string;
  /** The sending line as stored (an old name of a renamed line becomes its current one). Missing from older servers. */
  from_address?: string;
  in_reply_to?: string | null;
  /** v2: the message joined an earlier thread between the same two lines on its own (no `thread`, no `new_thread`). */
  continued?: boolean;
  tier: 'T0' | 'T1' | 'T2';
}

/**
 * One message as the API returns it. v1: the envelope, ciphertext and
 * wrapped keys (`body` null: only an agent with the right key opens it).
 * v2: `body` opened by the server; the v1 fields are null.
 */
export interface MessageDto {
  format: 'v1' | 'v2';
  /** v2 only: the body, opened by the server. null for v1, or once deleted after 30 days. */
  body: MessageBody | null;
  /** v2: the body could not be opened (key gone, damaged). */
  body_problem?: string;
  body_deleted: boolean;
  /** v2: sent from an agent (through the plugin) or from the web page. */
  via: 'agent' | 'web' | null;
  /** v2: the sending computer's label, or "web". */
  source: string | null;
  id: string;
  client_msg_id: string;
  from_address: string;
  to_address: string;
  from_user: string;
  to_user: string;
  tier: 'T0' | 'T1' | 'T2';
  kind: MessageKind;
  thread_id: string;
  in_reply_to: string | null;
  state: MessageState;
  /** v1 only. */
  sender_device: string | null;
  sent_at: string;
  created_at: string;
  state_at: string;
  expires_at: string;
  /** v1 only. */
  envelope: MessageEnvelope | null;
  /** v1 only. */
  ciphertext: string | null;
  /** v1: sha256 of the ciphertext; v2: of the body. */
  ciphertext_sha256: string | null;
  /** v1 only. */
  signature: string | null;
  size_bytes: number;
}

export interface MessageEventDto { state: MessageState; at: string; note: string | null; by_me: boolean }

export interface MailboxResponse { messages: MessageDto[]; next_before: string | null }
export interface MessageResponse { message: MessageDto; events: MessageEventDto[] }

export interface DeviceKeyDto {
  id: string;
  label: string;
  fingerprint: string;
  x25519_pub: string;
  ed25519_pub: string;
  created_at: string;
  last_seen_at?: string | null;
  /** null: pending -- registered, not yet approved by another of the person's devices. */
  approved_at: string | null;
  endorsed_by: string | null;
  /** Ed25519 by `endorsed_by` over endorsementBytes(user, this device). */
  endorsement: string | null;
  revoked_at: string | null;
}

export interface MessageIdentity {
  user_id: string;
  handle: string;
  /** false until the person picks their handle on the Messages page (20261031003000): a temporary one, or one from before. */
  handle_chosen?: boolean;
  /** agent_id: the Acta line this address is (20261025003000); aliases: its old names, still delivered to it. */
  endpoints: { name: string; address: string; label: string | null; last_used_at: string | null; agent_id?: string | null; aliases?: string[] }[];
  devices: DeviceKeyDto[];
}

export interface MessageKeysResponse { user_id: string; handle: string; devices: DeviceKeyDto[] }

/** POST /api/v1/devices/keys */
export const zDeviceKeyRegister = z.object({
  label: z.string().trim().min(1).max(80),
  x25519_pub: zB64u32,
  ed25519_pub: zB64u32,
  fingerprint: z.string().regex(/^[0-9a-f]{40}$/),
  /** Ed25519 by this key over registrationBytes(user, x25519, ed25519): proof the caller holds it. */
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type DeviceKeyRegister = z.infer<typeof zDeviceKeyRegister>;
export interface DeviceKeyRegistered { device_id: string; fingerprint: string; created: boolean; approved: boolean }

/** POST /api/v1/devices/keys/{id}/endorse */
export const zDeviceEndorse = z.object({ by: zUuid, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type DeviceEndorse = z.infer<typeof zDeviceEndorse>;

export interface MailboxPeek {
  unread: number; commands: number; latest_id: string | null; latest_at: string | null;
  /** Unread by receiving line ('' = the personal mailbox). */
  by_agent: Record<string, number>;
}

/**
 * The sealed body. `subject` is inside the ciphertext on purpose: a title is
 * content, and content reaches a model only through a pass-checked tool.
 */
export const zMessageBody = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(60_000),
  /** handoff: a share link (v2.1 22.4) the recipient opens with open_share. */
  share_url: z.string().url().max(400).optional(),
  /** command: what it would need on the recipient's machine (24.3). */
  capabilities: z.array(zCapability).max(5).optional(),
  /** Hard-rule replacements made before sealing, by rule (24.7). */
  masked: z.record(z.number().int()).optional(),
  /**
   * The sending conversation's short title (CLI 0.2.9): written by the agent
   * once per conversation, the same one it suggests when capturing it. The
   * page shows it on the card and in the thread list; the line (address)
   * stays the line. Masked like the rest of the body.
   */
  session_title: z.string().trim().min(1).max(120).optional(),
});
export type MessageBody = z.infer<typeof zMessageBody>;

// ── T1–T3: contacts, requests, invite links, blocks (migration 20261031001000; arch ch. 42) ──

/** A handle as a person types it: "@bob", " Bob " → "bob". */
export const zHandle = z.string().trim().toLowerCase().transform((s) => s.replace(/^@+/, ''))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, 'a handle is 3–32 letters, digits or -'));

/** An invite code as it appears in the link (base64url, from 24 random bytes). */
export const zInviteCode = z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/, 'not an invite code');

/** What the web contacts page posts (a browser session only: who may write to you changes on the web, 24.3). */
export const zContactAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), handle: zHandle, note: z.string().max(300).optional() }),
  z.object({ action: z.enum(['accept', 'decline', 'block_request']), id: zUuid }),
  z.object({ action: z.literal('cancel'), id: zUuid }),
  z.object({ action: z.enum(['remove', 'block', 'unblock']), handle: zHandle }),
  z.object({ action: z.literal('invite') }),
  z.object({ action: z.literal('revoke_invite'), id: zUuid }),
  z.object({ action: z.enum(['preview_invite', 'redeem_invite']), code: zInviteCode }),
  z.object({ action: z.literal('org_policy'), org: zUuid, internal: z.boolean().optional(), external: z.boolean().optional() }),
  // the person's own handle (20261031003000): is it free (as they type), then pick it
  z.object({ action: z.literal('check_handle'), handle: z.string().max(64) }),
  z.object({ action: z.literal('set_handle'), handle: zHandle }),
]);
export type ContactAction = z.infer<typeof zContactAction>;

export type MessageTier = 'T0' | 'T1' | 'T2' | 'T3';

/** message_contacts(): everything the contacts page shows, and what the agents' `contacts` tool reads. */
export interface MessageContacts {
  handle: string;
  /** false until the person picks their handle (20261031003000): a temporary user-xxxxxx, or the old one from their email. */
  handle_chosen: boolean;
  contacts: { handle: string; since: string; via: 'request' | 'invite'; tier: MessageTier }[];
  orgs: { org_id: string; name: string; admin: boolean; msg_internal: boolean; msg_external: boolean; members: { handle: string; role: 'admin' | 'member' }[] }[];
  requests_in: { id: string; handle: string; note: string | null; created_at: string }[];
  /** A decline reads as pending to the sender (30 days), on purpose. */
  requests_out: { id: string; handle: string; note: string | null; created_at: string; state: 'pending' }[];
  blocked: { handle: string; created_at: string }[];
  invites: { id: string; created_at: string; expires_at: string; used_at: string | null; used_by: string | null }[];
}

/**
 * message_handle_check(): is a handle free for the caller, and a few that are
 * when it is not. reason: format (not 3–32 a–z 0–9 -), reserved, taken (by
 * someone now, or released by them less than 90 days ago).
 */
export interface HandleCheck { handle: string; ok: boolean; reason: 'format' | 'reserved' | 'taken' | null; suggestions: string[]; current: string }
/** set_message_handle(): previous keeps reaching the person for 90 days. */
export interface HandleSet { handle: string; previous: string | null; changed: boolean }

export type InvitePreviewState = 'ok' | 'own' | 'already' | 'used' | 'expired' | 'revoked' | 'invalid';
export interface InvitePreview { state: InvitePreviewState; handle?: string; expires_at?: string }
export interface InviteCreated { id: string; code: string; url: string; expires_at: string }

/**
 * An address as a person or an agent writes it, for sending: `@bob` → `bob`
 * (their personal mailbox), `@bob/x` or `bob/x` → `bob/x`, anything else is
 * one of the sender's own lines (`<me>/<slug>`), or `<me>` itself.
 */
export function resolveAddress(to: string, me: string): string {
  const t = to.trim().toLowerCase();
  if (t.startsWith('@')) {
    const [h, name] = t.replace(/^@+/, '').split('/', 2) as [string, string | undefined];
    return name ? `${h}/${endpointSlug(name)}` : h;
  }
  if (!t.includes('/')) return t === me ? me : `${me}/${endpointSlug(t)}`;
  const [h, name] = t.split('/', 2) as [string, string];
  return `${h}/${endpointSlug(name)}`;
}

/** The account part of an address. */
export const handleOfAddress = (address: string): string => address.split('/')[0] ?? '';
