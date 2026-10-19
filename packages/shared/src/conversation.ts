import { sha256 } from './hash.ts';

/**
 * One conversation, captured more than once (arch 33; plan #110).
 *
 * A run used to be identified by its content alone, so the same conversation
 * captured on 10/15 and again on 10/18 -- with a few more turns -- became two
 * runs. These helpers are what ingest uses to recognise the second capture as
 * a continuation of the first and append only what is new.
 *
 * Everything here works on REDACTED text: the server stores the redacted
 * turns, so the client and the server can compute the same prints, and a
 * real name never becomes part of a key.
 */

/** Same text, same print: Unicode NFC, whitespace runs collapsed, ends trimmed. */
export function normalizeForPrint(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** The fingerprint of one user turn. 32 hex chars: a lookup key, not a secret. */
export const userPrint = (content: string): string => sha256(normalizeForPrint(content)).slice(0, 32);

/**
 * Prints of the user turns, in order. User turns are what the person typed --
 * the part least likely to be rewritten between two captures of the same
 * conversation. Assistant turns are not used: a model writing a record may
 * phrase its own replies differently every time.
 */
export const userPrints = (turns: readonly { role: string; content: string }[]): string[] =>
  turns.filter((t) => t.role === 'user').map((t) => userPrint(t.content));

/**
 * The index key for the fallback match: the first two user prints. One print
 * is too weak (many conversations open with "continue"); no lead at all for a
 * conversation with fewer than two user turns, so it can only ever be matched
 * by its conversation key.
 */
export const leadPrint = (prints: readonly string[]): string | null =>
  prints.length >= 2 ? sha256(`${prints[0]}:${prints[1]}`).slice(0, 32) : null;

/**
 * The conversation key: the platform's own id for this conversation (a
 * Claude Code session file, a Cowork session id, an export's conversation
 * uuid), hashed with the workspace it is uploaded to. Only the hash leaves
 * the machine; the same conversation uploaded to two workspaces gets two
 * unrelated keys, so the server cannot link them (arch #75).
 */
export const conversationKey = (namespace: string, platform: string, rawId: string): string =>
  sha256(`actario.conv/v1\u0000${namespace}\u0000${platform}\u0000${rawId}`).slice(0, 32);

/** What is already stored for a conversation, as far as alignment needs to know. */
export interface StoredConversation {
  /** Prints of the stored user turns, in order. */
  userPrints: readonly string[];
  /** Turns currently stored (idx 0..turnCount-1). */
  turnCount: number;
  /** Turns stored after the last user turn (the reply, tool turns...). */
  tail: number;
}

export type Alignment =
  /** Nothing new: the incoming capture is the stored one, or an earlier part of it. */
  | { kind: 'noop' }
  /** The incoming capture extends the stored one; turns from `from` on are new. */
  | { kind: 'append'; from: number }
  /** Same conversation key, but the stored user turns are not a prefix of the incoming ones. */
  | { kind: 'diverged' };

/**
 * Where does an incoming capture continue a stored one?
 *
 * The stored user turns must be, print for print, the first user turns of the
 * incoming capture. The cut is then made after the stored conversation's last
 * user turn plus as many turns as the stored copy had after it (never past the
 * next user turn) -- so a reply that was still being written at the first
 * capture is kept as it was stored (stored turns are never rewritten) and
 * only what follows is appended.
 */
export function alignCapture(
  stored: StoredConversation,
  incoming: readonly { role: string; content: string }[],
): Alignment {
  const s = stored.userPrints;
  const n = userPrints(incoming);
  if (s.length === 0) return stored.turnCount >= incoming.length ? { kind: 'noop' } : { kind: 'diverged' };

  if (n.length < s.length) {
    for (let i = 0; i < n.length; i++) if (n[i] !== s[i]) return { kind: 'diverged' };
    return { kind: 'noop' };
  }
  for (let i = 0; i < s.length; i++) if (n[i] !== s[i]) return { kind: 'diverged' };

  // Position of the stored conversation's last user turn in the incoming one.
  let seen = 0;
  let pos = -1;
  for (let i = 0; i < incoming.length; i++) {
    if (incoming[i]!.role !== 'user') continue;
    seen++;
    if (seen === s.length) { pos = i; break; }
  }
  // Skip as many turns as the stored copy had after that user turn, but never
  // past the next user turn: a capture that wrote the reply as one turn where
  // the stored copy had three must not swallow the next question.
  let nextUser = incoming.length;
  for (let i = pos + 1; i < incoming.length; i++) if (incoming[i]!.role === 'user') { nextUser = i; break; }
  const from = Math.min(pos + 1 + stored.tail, nextUser);
  return from >= incoming.length ? { kind: 'noop' } : { kind: 'append', from };
}

/** The `raw_ext.conversation_ref` an adapter may set; read and removed by the capture pipeline. */
export const CONVERSATION_REF_KEY = 'conversation_ref';
/** The `raw_ext.conv_key` the capture pipeline writes for the server. */
export const CONVERSATION_KEY_FIELD = 'conv_key';
/** The `raw_ext.continues_from` a partial Cowork record carries (arch 33.4). */
export const CONTINUES_FROM_FIELD = 'continues_from';
