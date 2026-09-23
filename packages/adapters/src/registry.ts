import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '@distill/shared';
import type { CaptureAdapter } from './types.ts';
import { chatgptExport } from './chatgpt-export.ts';
import { claudeExport } from './claude-export.ts';
import { claudeDesktopLocal } from './claude-desktop.ts';
import { claudeCodeSession2026_08 } from './claude-code.ts';
import { coworkLive } from './cowork-live.ts';

/**
 * Built-in adapters, most specific first.
 *
 * Multiple versions of the same `id` coexist on purpose (6.3 rule 3): a new
 * source layout arrives as an added entry, never as an edit to an existing
 * one, so the old golden fixtures keep passing and old archives keep parsing.
 * `sniff()` picks the version; all of them failing falls through to the loose
 * parser rather than to an error.
 */
export const BUILTIN_ADAPTERS: CaptureAdapter[] = [
  // First: its format is explicit and versioned, so its sniff is the most
  // specific of the set and never claims another source's file.
  coworkLive,
  claudeCodeSession2026_08,
  chatgptExport,
  claudeExport,
  claudeDesktopLocal,
];

export const adapterKey = (a: CaptureAdapter): string => `${a.id}@${a.version}`;

export const adaptersById = (id: string, all = BUILTIN_ADAPTERS): CaptureAdapter[] =>
  all.filter((a) => a.id === id);

function looksLikeAdapter(v: unknown): v is CaptureAdapter {
  const a = v as Partial<CaptureAdapter> | null;
  return !!a
    && typeof a.id === 'string'
    && typeof a.version === 'string'
    && typeof a.detect === 'function'
    && typeof a.collect === 'function'
    && typeof a.toUCF === 'function'
    && typeof a.sniff === 'function'
    && !!a.capabilities;
}

/**
 * User-supplied adapters from ~/.actario/adapters/*.mjs -- the last line of
 * defence in the compatibility story (C5). It is also the immediate answer to
 * "you do not support my format": the user writes one file, no release
 * required. The code runs on the user's machine and is never uploaded.
 */
export async function loadUserAdapters(dir: string): Promise<CaptureAdapter[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.mjs') || n.endsWith('.js'));
  } catch {
    return [];
  }

  const loaded: CaptureAdapter[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      const candidate = mod.default ?? mod.adapter;
      if (looksLikeAdapter(candidate)) {
        loaded.push(candidate);
        logger.info('loaded user adapter', { adapter: adapterKey(candidate), path });
      } else {
        logger.warn('user adapter ignored: does not match the CaptureAdapter interface', { path });
      }
    } catch (e) {
      // One broken user file must not stop a capture (C5).
      logger.warn('user adapter failed to load', { path, error: (e as Error).message });
    }
  }
  return loaded;
}

export async function allAdapters(userAdapterDir?: string): Promise<CaptureAdapter[]> {
  const user = userAdapterDir ? await loadUserAdapters(userAdapterDir) : [];
  // User adapters win: if someone wrote one, it is because ours was wrong.
  return [...user, ...BUILTIN_ADAPTERS];
}
