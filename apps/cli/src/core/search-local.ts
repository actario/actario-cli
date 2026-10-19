import { unmaskText } from '@distill/export';
import type { RedactionEngine } from '@distill/redaction';

/**
 * Search with real names, from this machine (arch 28.7).
 *
 * What was uploaded is masked: 「王小明」 is `USER-1A2B3C` on the server, so a
 * search for the real name finds nothing there. The map between the two
 * lives only on this machine (C6). So the query is masked HERE before it is
 * sent -- every value this machine has pseudonymised is swapped for its
 * pseudonym, and anything the rules would mask (an email typed fresh) goes
 * through the same rules with the same salt -- and the snippets that come
 * back are unmasked here. The server sees pseudonyms only, as always (#77).
 *
 * `reverse` is share.ts revealMap(): pseudonym -> original, without the hard
 * rules and redaction_terms (those are never shown, so never searched for by
 * their real value either).
 */
export function maskQuery(
  q: string, reverse: Map<string, string> | null, engine?: Pick<RedactionEngine, 'redactText'>,
): { q: string; replaced: number } {
  // Filter values (line:, tag:, kind: ...) are compared with what was stored
  // unmasked (line names) or already free of names (tags): leave them alone.
  const keep: [number, number][] = [];
  for (const m of q.matchAll(FILTER)) keep.push([m.index!, m.index! + m[0].length]);
  const inKept = (i: number) => keep.some(([a, b]) => i >= a && i < b);

  let replaced = 0;
  let out = q;
  if (reverse && reverse.size > 0) {
    const forward = new Map<string, string>();
    for (const [pseudo, orig] of reverse) if ([...orig].length >= 2) forward.set(orig.toLowerCase(), pseudo);
    if (forward.size > 0) {
      // One pass, longest original first, so a replacement is never matched
      // again and "Wang Xiaoming" wins over "Wang". Latin names only as whole
      // words ("Li" is not inside "linux"); CJK has no word breaks.
      const alts = [...forward.keys()].sort((a, b) => b.length - a.length).map((o) => {
        const e = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return CJK.test(o) ? e : `(?<![\\p{L}\\p{N}])${e}(?![\\p{L}\\p{N}])`;
      });
      const re = new RegExp(alts.join('|'), 'giu');
      out = q.replace(re, (m: string, ...rest: unknown[]) => {
        const at = rest.find((x) => typeof x === 'number') as number;
        if (inKept(at)) return m;
        const p = forward.get(m.toLowerCase());
        if (!p) return m;
        replaced++;
        return p;
      });
    }
  }
  if (engine && keep.length === 0) {
    const r = engine.redactText(out);
    replaced += r.hits.length;
    out = r.text;
  } else if (engine) {
    // Run the rules over the words only, never over the filters.
    const parts: string[] = [];
    let last = 0;
    const spans = [...out.matchAll(FILTER)].map((m) => [m.index!, m.index! + m[0].length] as const);
    for (const [a, b] of spans) {
      const r = engine.redactText(out.slice(last, a)); replaced += r.hits.length; parts.push(r.text, out.slice(a, b)); last = b;
    }
    const r = engine.redactText(out.slice(last)); replaced += r.hits.length; parts.push(r.text);
    out = parts.join('');
  }
  return { q: out, replaced };
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
/** The filters of packages/shared search-query.ts, as spans of the raw query. */
const FILTER = /(?:^|(?<=\s))(?:(?:tag|line|kind|in|type|after|since|before|until|標籤|線|工作線):(?:"[^"]*"|\S+)|#\S+)/giu;

/** Unmask every string field named in `keys`, in place, on a list of hits. */
export function unmaskHits<T extends Record<string, unknown>>(hits: T[] | undefined, reverse: Map<string, string> | null, keys: (keyof T)[]): T[] {
  if (!hits) return [];
  if (!reverse || reverse.size === 0) return hits;
  return hits.map((h) => {
    const c: Record<string, unknown> = { ...h };
    for (const k of keys) if (typeof c[k as string] === 'string') c[k as string] = unmaskText(c[k as string] as string, reverse).text;
    return c as T;
  });
}
