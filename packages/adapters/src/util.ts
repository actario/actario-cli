import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawUnit } from './types.ts';

export async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Depth-limited walk. Session directories nest a couple of levels, not ten. */
export async function walkFiles(
  root: string,
  match: (name: string) => boolean,
  maxDepth = 3,
): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await visit(p, depth + 1);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  };
  await visit(root, 0);
  return out;
}

export async function fileUnit(path: string): Promise<RawUnit> {
  const s = await stat(path);
  return {
    unitId: path,
    path,
    bytes: s.size,
    mtime: s.mtime.toISOString(),
    read: () => readFile(path, 'utf8'),
  };
}

export function textUnit(unitId: string, path: string, text: string, mtime: string | null): RawUnit {
  return {
    unitId,
    path,
    bytes: Buffer.byteLength(text, 'utf8'),
    mtime,
    read: async () => text,
  };
}

export const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Flattens Anthropic-style content blocks into plain text. */
/**
 * Splits a message's content blocks into the conversation text and the tool
 * output attached to it (v1.2). Tool results used to be folded into `content`;
 * they now travel in their own field so they can be capped and scored on
 * their own terms -- a 2,000-line `Read` result is what the conversation
 * looked at, not the conversation.
 */
export function splitBlocks(content: unknown): { text: string; toolResult: string | null } {
  if (typeof content === 'string') return { text: content, toolResult: null };
  if (!Array.isArray(content)) return { text: '', toolResult: null };
  const text: string[] = [];
  const results: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') { text.push(b); continue; }
    if (!b || typeof b !== 'object') continue;
    const blk = b as Record<string, unknown>;
    if (blk.type === 'tool_result') {
      const r = blocksToText(blk.content);
      if (r.length > 0) results.push(r);
    } else if (typeof blk.text === 'string') text.push(blk.text);
    else if (blk.type === 'thinking' && typeof blk.thinking === 'string') text.push(blk.thinking);
  }
  return { text: text.join('\n'), toolResult: results.length > 0 ? results.join('\n') : null };
}

/**
 * Cuts a string at a UTF-8 byte budget without splitting a code point. Used
 * for tool_result, whose cap is defined in bytes (open #9) because that is
 * the unit the server stores and the corpus measures.
 */
export function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return { text: s.slice(0, end), truncated: true };
}

export function capChars(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars)}...[truncated by capture]` : s;
}

export function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') { parts.push(b); continue; }
    if (!b || typeof b !== 'object') continue;
    const blk = b as Record<string, unknown>;
    if (typeof blk.text === 'string') parts.push(blk.text);
    else if (blk.type === 'tool_result' && blk.content) parts.push(blocksToText(blk.content));
    else if (blk.type === 'thinking' && typeof blk.thinking === 'string') parts.push(blk.thinking);
  }
  return parts.join('\n');
}
