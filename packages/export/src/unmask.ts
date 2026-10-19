import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Local reversal of stable pseudonyms (design unit 0001 §4.4).
 *
 * The server never does this and cannot: pseudonyms are HMACs under a salt
 * that has never left ~/.actario, and the original → pseudonym map is written
 * there encrypted (redaction/store.ts). Reversal is therefore a step the user
 * runs on their own machine, explicitly, on an export they already hold.
 *
 * Everything in this file is pure: bytes in, bytes out, plus a report. File
 * and key handling live in the CLI command.
 */

export interface RedactionMapFile {
  version: 1;
  entries: { original: string; pseudonym: string }[];
}

/** pseudonym → original, longest pseudonym first so no token is a prefix of a later one. */
export function reverseMap(map: RedactionMapFile): Map<string, string> {
  const pairs = [...map.entries].sort((a, b) => b.pseudonym.length - a.pseudonym.length);
  return new Map(pairs.map((e) => [e.pseudonym, e.original]));
}

/** Shape produced by pseudonymFor(): `<PREFIX>-<6 hex>`. Used only to count unknowns. */
const PSEUDONYM = /\b([A-Z]{2,12})-([0-9A-F]{6})\b/g;

export interface UnmaskReport {
  /** Replacements per rule prefix (KEY, EMAIL, PHONE, ...). */
  replaced: Record<string, number>;
  /**
   * Tokens that look like pseudonyms but are not in this machine's map --
   * typically data captured elsewhere. Reported, never guessed at.
   */
  unknown: number;
  unknown_samples: string[];
}

const emptyReport = (): UnmaskReport => ({ replaced: {}, unknown: 0, unknown_samples: [] });

function merge(into: UnmaskReport, from: UnmaskReport): UnmaskReport {
  for (const [k, v] of Object.entries(from.replaced)) into.replaced[k] = (into.replaced[k] ?? 0) + v;
  into.unknown += from.unknown;
  for (const s of from.unknown_samples) {
    if (into.unknown_samples.length >= 10 || into.unknown_samples.includes(s)) continue;
    into.unknown_samples.push(s);
  }
  return into;
}

export function unmaskText(text: string, reverse: Map<string, string>): { text: string; report: UnmaskReport } {
  const report = emptyReport();
  if (!text || reverse.size === 0) {
    // Still count unknowns: an empty local map with a pseudonym-laden export
    // is exactly the "captured on another machine" case the report exists for.
    return { text, report: countUnknown(text, reverse, report) };
  }
  let out = text;
  for (const [pseudonym, original] of reverse) {
    if (!out.includes(pseudonym)) continue;
    const parts = out.split(pseudonym);
    const n = parts.length - 1;
    if (n === 0) continue;
    out = parts.join(original);
    const prefix = pseudonym.slice(0, pseudonym.indexOf('-')) || pseudonym;
    report.replaced[prefix] = (report.replaced[prefix] ?? 0) + n;
  }
  return { text: out, report: countUnknown(out, reverse, report) };
}

function countUnknown(text: string, reverse: Map<string, string>, report: UnmaskReport): UnmaskReport {
  for (const m of text.matchAll(PSEUDONYM)) {
    const tok = m[0];
    if (reverse.has(tok)) continue;
    report.unknown += 1;
    if (report.unknown_samples.length < 10 && !report.unknown_samples.includes(tok)) report.unknown_samples.push(tok);
  }
  return report;
}

export interface Member { name: string; data: Uint8Array }

const TEXT_EXT = /\.(json|jsonl|ndjson|md|txt)$/i;
const isGz = (name: string) => name.toLowerCase().endsWith('.gz');
/** Text-like members get rewritten; anything else is copied byte for byte. */
export const isTextMember = (name: string): boolean =>
  TEXT_EXT.test(isGz(name) ? name.slice(0, -3) : name);

export function unmaskMember(m: Member, reverse: Map<string, string>): { member: Member; report: UnmaskReport } {
  if (!isTextMember(m.name)) return { member: m, report: emptyReport() };
  const gz = isGz(m.name);
  const raw = gz ? gunzipSync(m.data) : Buffer.from(m.data);
  const { text, report } = unmaskText(raw.toString('utf8'), reverse);
  const bytes = Buffer.from(text, 'utf8');
  return { member: { name: m.name, data: gz ? gzipSync(bytes, { level: 6 }) : bytes }, report };
}

/** The whole archive's members, rewritten, plus one merged report. */
export function unmaskMembers(members: Member[], reverse: Map<string, string>): { members: Member[]; report: UnmaskReport } {
  const report = emptyReport();
  const out = members.map((m) => {
    const r = unmaskMember(m, reverse);
    merge(report, r.report);
    return r.member;
  });
  return { members: out, report };
}

/** Marker written next to an unmasked export so nobody mistakes it for something safe to re-upload. */
export const UNMASK_MARKER_NAME = 'UNMASKED-DO-NOT-CAPTURE';
export const UNMASK_MARKER_TEXT =
  'This directory holds an Actario export with pseudonyms reversed using the\n' +
  'redaction map on this machine. It contains original values that were removed\n' +
  'before upload. Do not place it under ~/.actario/inbox or any captured path.\n';
