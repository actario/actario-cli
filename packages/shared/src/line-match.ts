import { normalizeTag } from './tags.ts';

/**
 * Which line does an unfiled run belong to (plan v3.1 21.4, arch 28.4; #84).
 *
 * Pure and deterministic on purpose: the server uses it when no agent judged
 * the run (automatic upload, an older skill), and `suggest_line` uses it to
 * rank candidates for the agent that will judge. Same numbers both ways, and
 * testable without a database.
 *
 * The model is a tag-weighted cosine:
 *   - a line's profile is the tags of its recent runs (weighted, newer
 *     heavier -- the SQL side does the decay), plus the words of its name and,
 *     for a default category, its seed tags;
 *   - every tag is weighted by its rarity across the workspace's lines (idf),
 *     so a tag on every line ("筆記") counts for little;
 *   - CJK has no word breaks, so containment counts most of a match: "京都" on
 *     a line and "京都旅行" on a run are related, not equal.
 * A line's profile is built from what is already in it, so a person moving a
 * run in teaches the next match without anything else to train.
 */

export const MATCH_THRESHOLDS = {
  /** At or above: file it, confidently. */
  high: 0.45,
  /** At or above: file it, but say it should be checked. Below: not alike. */
  low: 0.25,
  /** A proposed new line this close to an existing name is that line. */
  sameName: 0.6,
  categoryBonus: 0.1,
} as const;

export interface LineProfile {
  id: string;
  name: string;
  lineKind: 'topic' | 'category';
  categoryKey: string | null;
  /** tag_norm -> weight (already decayed). Seeds and name words are added here by buildProfile. */
  weights: Record<string, number>;
}

export interface RunTags {
  tags: readonly string[];
  category?: string | null;
}

export interface LineScore {
  id: string;
  name: string;
  lineKind: 'topic' | 'category';
  score: number;
  /** The run tags that carried the score, strongest first. */
  reasons: { tag: string; w: number }[];
}

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;

/** The words a line's name contributes: the whole name, and its space/punctuation-separated parts. */
export function nameWords(name: string): string[] {
  const whole = normalizeTag(name).replace(/\s+conversations$/, '');
  const parts = whole.split(/[\s\p{P}\p{S}]+/u).map((p) => p.trim()).filter((p) => [...p].length >= 2);
  // "<project> conversations" is how lines made from a project are named; the suffix says nothing.
  const filtered = parts.filter((p) => p !== 'conversations');
  return [...new Set([whole, ...filtered].filter((w) => w && w !== 'conversations'))];
}

/** A profile from raw rows: tag weights plus name words and seeds (each at weight 2). */
export function buildProfile(
  line: { id: string; name: string; lineKind: 'topic' | 'category'; categoryKey: string | null },
  tagWeights: Record<string, number>,
  seeds: readonly string[] = [],
): LineProfile {
  const weights: Record<string, number> = { ...tagWeights };
  for (const w of [...nameWords(line.name), ...seeds.map(normalizeTag)]) {
    if (!w) continue;
    weights[w] = Math.max(weights[w] ?? 0, 2);
  }
  return { ...line, weights };
}

/** 1 equal; one contains the other (at least two characters): 0.7 for CJK, 0.5 for a whole Latin word; else 0. */
export function tagSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [s, l] = [...a].length <= [...b].length ? [a, b] : [b, a];
  if ([...s].length < 2 || !l.includes(s)) return 0;
  // CJK words run together (京都 / 京都旅行), so containment is strong evidence there.
  if (CJK.test(s)) return 0.7;
  // Latin: only as a whole word, so "art" does not match "start".
  return new RegExp(`(^|[^\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(l) ? 0.5 : 0;
}

/** Rank every line against a run's tags. Highest first; ties by name. */
export function scoreLines(run: RunTags, lines: readonly LineProfile[]): LineScore[] {
  const tags = [...new Set(run.tags.map(normalizeTag).filter(Boolean))];
  const n = lines.length;
  if (n === 0) return [];
  const df = new Map<string, number>();
  for (const l of lines) for (const t of Object.keys(l.weights)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
  // A run tag no line has is still rare -- give it the idf of df = 0.
  const runVec = tags.map((t) => ({ t, w: idf(t) }));
  const runNorm = Math.sqrt(runVec.reduce((s, x) => s + x.w * x.w, 0));

  const out: LineScore[] = lines.map((l) => {
    const entries = Object.entries(l.weights).filter(([, w]) => w > 0).map(([t, w]) => ({ t, w: w * idf(t) }));
    const lineNorm = Math.sqrt(entries.reduce((s, x) => s + x.w * x.w, 0));
    const reasons: { tag: string; w: number }[] = [];
    let dot = 0;
    if (runNorm > 0 && lineNorm > 0) {
      for (const r of runVec) {
        let best = 0;
        for (const e of entries) {
          const sim = tagSimilarity(r.t, e.t);
          if (sim > 0) best = Math.max(best, sim * r.w * e.w);
        }
        if (best > 0) { dot += best; reasons.push({ tag: r.t, w: best }); }
      }
    }
    let score = runNorm > 0 && lineNorm > 0 ? dot / (runNorm * lineNorm) : 0;
    if (run.category && l.categoryKey && run.category === l.categoryKey && score > 0) score += MATCH_THRESHOLDS.categoryBonus;
    score = Math.min(1, score);
    const total = reasons.reduce((s, x) => s + x.w, 0) || 1;
    return {
      id: l.id, name: l.name, lineKind: l.lineKind,
      score: Math.round(score * 1000) / 1000,
      reasons: reasons.sort((a, b) => b.w - a.w).slice(0, 5).map((x) => ({ tag: x.tag, w: Math.round((x.w / total) * 100) / 100 })),
    };
  });
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Character-bigram Dice similarity of two names, normalised. Works for CJK and Latin alike. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeTag(a).replace(/\s+conversations$/, '').replace(/\s+/g, '');
  const nb = normalizeTag(b).replace(/\s+conversations$/, '').replace(/\s+/g, '');
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const grams = (s: string) => {
    const cs = [...s];
    if (cs.length < 2) return new Map([[s, 1]]);
    const m = new Map<string, number>();
    for (let i = 0; i < cs.length - 1; i++) { const g = cs[i]! + cs[i + 1]!; m.set(g, (m.get(g) ?? 0) + 1); }
    return m;
  };
  const ga = grams(na), gb = grams(nb);
  let inter = 0, total = 0;
  for (const [, c] of ga) total += c;
  for (const [, c] of gb) total += c;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) ?? 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

export type LineDecision =
  | { action: 'existing'; agentId: string; method: 'hint' | 'formula'; score: number | null; needsReview: boolean; reasons: { tag: string; w: number }[] }
  | { action: 'new'; name: string; method: 'new_line'; reasons: { tag: string; w: number }[] }
  | { action: 'category'; agentId: string; method: 'fallback'; suggestedName: string | null }
  | { action: 'unbound'; suggestedName: string | null };

export interface DecideInput {
  tags: readonly string[];
  category: string | null;
  scope: 'topic' | 'oneoff' | null;
  /** 'agent' and 'hosted' tags are a model's; 'mech' tags are guesses (#45: never enough to open a line). */
  strength: 'model' | 'mech';
  hint: { agentId?: string | null; newName?: string | null } | null;
  /** Lines the run's owner can see and file into (topic and category). */
  lines: readonly LineProfile[];
  /** Whether this workspace's plan has default categories right now (#86, #48). */
  categoriesEnabled: boolean;
}

/** A name for a new line from its tags: the first two, joined. */
export const nameFromTags = (tags: readonly string[]): string | null =>
  tags.length === 0 ? null : tags.slice(0, 2).join(' ').slice(0, 40);

/**
 * The three-step rule of 21.4, after the agent's hint:
 *   1. alike enough to a topic line -> that line;
 *   2. not alike, a continuing topic, judged by a model -> a new line
 *      (unless a line of nearly that name exists -- then that line);
 *   3. otherwise -> the category its facet names (when categories are on),
 *      else unfiled (`unbound`, shown as 未分類).
 * Whether a new line can actually be opened (the plan's line limit) is the
 * caller's to check; on refusal it falls back the way step 3 does.
 */
export function decideLine(input: DecideInput): LineDecision {
  const usable = input.categoriesEnabled ? input.lines : input.lines.filter((l) => l.lineKind === 'topic');
  const byId = new Map(usable.map((l) => [l.id, l]));
  const scored = scoreLines({ tags: input.tags, category: input.category }, usable);
  const reasonsFor = (id: string) => scored.find((s) => s.id === id)?.reasons ?? [];
  const sameNamed = (name: string) =>
    usable.map((l) => ({ l, s: nameSimilarity(name, l.name) })).filter((x) => x.s >= MATCH_THRESHOLDS.sameName).sort((a, b) => b.s - a.s)[0]?.l ?? null;
  const categoryLine = () => {
    if (!input.categoriesEnabled || !input.category) return null;
    return usable.find((l) => l.lineKind === 'category' && l.categoryKey === input.category) ?? null;
  };
  const suggested = input.hint?.newName?.trim() || nameFromTags(input.tags);

  // The agent's judgement first: it read the conversation and knows that
  // 京都行程 and 關西旅行 are the same trip; the formula only sees words.
  if (input.hint?.agentId && byId.has(input.hint.agentId)) {
    const s = scored.find((x) => x.id === input.hint!.agentId);
    return { action: 'existing', agentId: input.hint.agentId, method: 'hint', score: s?.score ?? null, needsReview: false, reasons: s?.reasons ?? [] };
  }
  if (input.hint?.newName?.trim() && input.strength === 'model') {
    const same = sameNamed(input.hint.newName);
    if (same) return { action: 'existing', agentId: same.id, method: 'hint', score: scored.find((x) => x.id === same.id)?.score ?? null, needsReview: false, reasons: reasonsFor(same.id) };
  }

  const bestTopic = scored.find((s) => s.lineKind === 'topic');
  if (bestTopic && bestTopic.score >= MATCH_THRESHOLDS.low) {
    return { action: 'existing', agentId: bestTopic.id, method: 'formula', score: bestTopic.score, needsReview: bestTopic.score < MATCH_THRESHOLDS.high, reasons: bestTopic.reasons };
  }

  if (input.strength === 'model' && (input.scope === 'topic' || !!input.hint?.newName?.trim()) && suggested) {
    const same = sameNamed(suggested);
    if (same) return { action: 'existing', agentId: same.id, method: 'formula', score: scored.find((x) => x.id === same.id)?.score ?? null, needsReview: true, reasons: reasonsFor(same.id) };
    return { action: 'new', name: suggested, method: 'new_line', reasons: [] };
  }

  // No facet to go by: a category is still right when the tags plainly say so (its seeds, or runs already in it).
  const bestCategory = input.categoriesEnabled && !input.category ? scored.find((s) => s.lineKind === 'category') : undefined;
  if (bestCategory && bestCategory.score >= MATCH_THRESHOLDS.high) {
    return { action: 'category', agentId: bestCategory.id, method: 'fallback', suggestedName: null };
  }
  const cat = categoryLine();
  if (cat) return { action: 'category', agentId: cat.id, method: 'fallback', suggestedName: input.scope === 'topic' ? suggested : null };
  return { action: 'unbound', suggestedName: input.scope === 'topic' ? suggested : null };
}
