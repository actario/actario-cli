import type { CaptureAdapter } from '@distill/adapters';

export type ParseLevel = 'strict' | 'loose' | 'raw';

export interface SniffResult {
  level: ParseLevel;
  /** Set only for level 'strict'. */
  adapter?: CaptureAdapter;
  /** Which adapter versions were tried and rejected -- `doctor` prints this. */
  rejected: string[];
}

/**
 * Chooses the parse level for one unit (6.3).
 *
 * The order is strict -> loose -> raw, and the decision is per unit, not per
 * source: one session file whose layout moved falls back on its own while the
 * rest of the batch stays strict.
 */
export function sniffUnit(text: string, candidates: CaptureAdapter[]): SniffResult {
  const rejected: string[] = [];
  for (const a of candidates) {
    try {
      if (a.sniff(text)) return { level: 'strict', adapter: a, rejected };
    } catch {
      // A throwing sniff is a rejection, not a crash.
    }
    rejected.push(`${a.id}@${a.version}`);
  }
  return { level: looksStructured(text) ? 'loose' : 'raw', rejected };
}

/** Is there any JSON or JSONL in here for the loose parser to work with? */
export function looksStructured(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim();
  return !!firstLine && (firstLine.startsWith('{') || firstLine.startsWith('['));
}
