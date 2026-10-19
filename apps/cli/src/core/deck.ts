import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { actarioDir } from '@distill/capture';
import { renderDeck, zDeckSpec, type DeckSpecInput } from '@distill/slides';
import { DistillError } from '@distill/shared';

/**
 * The agent-written slide deck (improvement plan C2): the user's own agent
 * writes a DeckSpec from a run or a memory it fetched, and this renders it to
 * a .pptx on this machine with the same renderer the web uses for its
 * assembled deck. Nothing is uploaded.
 */
export const decksDir = (): string => join(actarioDir(), 'decks');

/** A file name from the title: letters, digits and CJK kept, the rest dashed. */
export function deckFileName(title: string, date = new Date()): string {
  const base = title.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck';
  return `${base}-${date.toISOString().slice(0, 10)}`;
}

export async function makeDeck(spec: DeckSpecInput, opts: { dir?: string; name?: string } = {}): Promise<{ path: string; slides: number; bytes: number }> {
  const parsed = zDeckSpec.safeParse(spec);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    throw new DistillError('invalid_request', `The deck spec is not valid at ${i.path.join('.') || '(root)'}: ${i.message}`, parsed.error.issues.slice(0, 10), 400);
  }
  if (opts.dir && !isAbsolute(opts.dir)) throw new DistillError('invalid_request', '`dir` must be an absolute path to an existing folder.', undefined, 400);
  const dir = opts.dir ? resolve(opts.dir) : decksDir();
  if (opts.dir && !existsSync(dir)) throw new DistillError('invalid_request', `No such folder: ${dir}`, undefined, 400);
  mkdirSync(dir, { recursive: true });
  const stem = deckFileName(opts.name ?? parsed.data.title);
  const buf = await renderDeck(parsed.data);
  // 'wx': create, never replace -- not an existing file, not what a symlink points at, not a file another call wrote a moment ago.
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? `${stem}.pptx` : `${stem}-${n}.pptx`);
    try {
      writeFileSync(path, buf, { flag: 'wx' });
      return { path, slides: parsed.data.slides.length + 1, bytes: buf.length };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new DistillError('invalid_request', `Too many decks named ${stem} in ${dir}; give a different name.`, undefined, 409);
}
