import { FACET_OUTPUTS, normalizeTag, type FacetOutput } from './tags.ts';

/**
 * The search box's little language (arch 28.7, T3):
 *
 *   秋季 定價 tag:週報 #記帳 line:工作紀要 kind:page,file type:doc after:2026-09 before:2026-10-15 "exact phrase"
 *
 *   tag:x / #x       runs carrying tag x (all of them, normalised like tags.ts)
 *   line:x           one line, by name (resolved by the caller against the lines it can see)
 *   kind:a,b         only these kinds of hit (friendly names, see KIND_ALIASES)
 *   type:x           runs whose outputs facet has x (code, doc, slides, sheet, image, data, config)
 *   after:/before:   last activity; YYYY, YYYY-MM or YYYY-MM-DD; before is exclusive
 *   "..."            kept together, spaces and all
 *
 * Everything else is the words. Shared by the web, the API and the CLI so a
 * query means the same thing wherever it is typed.
 */
export const SEARCH_KINDS_V2 = ['lines', 'runs', 'pages', 'segments', 'turns', 'outputs', 'tags', 'notes', 'memory'] as const;
export type SearchKindV2 = (typeof SEARCH_KINDS_V2)[number];

export const KIND_ALIASES: Record<string, SearchKindV2> = {
  line: 'lines', lines: 'lines',
  run: 'runs', runs: 'runs', conversation: 'runs', conversations: 'runs', session: 'runs', sessions: 'runs', chat: 'runs', 對話: 'runs',
  page: 'pages', pages: 'pages', note: 'pages', 筆記頁: 'pages',
  summary: 'segments', summaries: 'segments', segment: 'segments', segments: 'segments', 摘要: 'segments',
  turn: 'turns', turns: 'turns', text: 'turns', 原文: 'turns',
  file: 'outputs', files: 'outputs', output: 'outputs', outputs: 'outputs', 產出: 'outputs', 檔案: 'outputs',
  tag: 'tags', tags: 'tags', 標籤: 'tags',
  notes: 'notes', wiki: 'notes',
  memory: 'memory', memories: 'memory', 記憶: 'memory',
};

export interface ParsedSearch {
  /** The words, quotes removed, joined by single spaces. */
  words: string;
  tags: string[];
  line: string | null;
  kinds: SearchKindV2[] | null;
  types: FacetOutput[];
  /** ISO dates (inclusive / exclusive), or null. */
  after: string | null;
  before: string | null;
  /** Filters that were not understood, as typed -- shown back, never silently dropped. */
  unknown: string[];
}

const TOKEN = /(\S+?):"([^"]*)"|"([^"]*)"|(\S+)/g;

function day(v: string, end: boolean): string | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : null, d = m[3] ? Number(m[3]) : null;
  if ((mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > 31))) return null;
  // `before:2026-10` means before October starts; `before:2026` before 2026 starts.
  // `after:` the same coordinates are the first moment of that period.
  void end;
  const date = new Date(Date.UTC(y, (mo ?? 1) - 1, d ?? 1));
  // 2026-02-31 is not a day (Date would roll it to 03-03).
  if (Number.isNaN(date.getTime()) || date.getUTCMonth() !== (mo ?? 1) - 1 || date.getUTCDate() !== (d ?? 1)) return null;
  return date.toISOString().slice(0, 10);
}

export function parseSearch(input: string): ParsedSearch {
  const out: ParsedSearch = { words: '', tags: [], line: null, kinds: null, types: [], after: null, before: null, unknown: [] };
  const words: string[] = [];
  for (const m of input.matchAll(TOKEN)) {
    const [, qKey, qVal, phrase, bare] = m;
    if (phrase !== undefined) { if (phrase.trim()) words.push(phrase.trim()); continue; }
    let key: string | null = null; let val = '';
    if (qKey !== undefined) { key = qKey; val = qVal ?? ''; }
    else if (bare!.startsWith('#') && bare!.length > 1) { key = 'tag'; val = bare!.slice(1); }
    else {
      const i = bare!.indexOf(':');
      // "12:30", "http://", a word ending in ':' -- not filters.
      if (i > 0 && i < bare!.length - 1 && /^[a-z\u4e00-\u9fff]+$/i.test(bare!.slice(0, i)) && !bare!.includes('://')) { key = bare!.slice(0, i); val = bare!.slice(i + 1); }
    }
    if (key === null) { words.push(bare!); continue; }
    const k = key.toLowerCase();
    if (k === 'tag' || k === '標籤') { const n = normalizeTag(val); if (n) out.tags.push(n); continue; }
    if (k === 'line' || k === '線' || k === '工作線') { if (val.trim()) out.line = val.trim(); continue; }
    if (k === 'kind' || k === 'in') {
      const ks = val.split(',').map((x) => KIND_ALIASES[x.trim().toLowerCase()]).filter((x): x is SearchKindV2 => !!x);
      if (ks.length === 0) { out.unknown.push(`${key}:${val}`); continue; }
      out.kinds = [...new Set([...(out.kinds ?? []), ...ks])];
      continue;
    }
    if (k === 'type') {
      const ts = val.split(',').map((x) => x.trim().toLowerCase()).filter((x): x is FacetOutput => (FACET_OUTPUTS as readonly string[]).includes(x));
      if (ts.length === 0) { out.unknown.push(`${key}:${val}`); continue; }
      out.types = [...new Set([...out.types, ...ts])];
      continue;
    }
    if (k === 'after' || k === 'since' || k === 'before' || k === 'until') {
      const d = day(val, k === 'before' || k === 'until');
      if (!d) { out.unknown.push(`${key}:${val}`); continue; }
      if (k === 'after' || k === 'since') out.after = d; else out.before = d;
      continue;
    }
    // Not one of ours: it was a word with a colon in it.
    words.push(`${key}:${val}`);
  }
  out.tags = [...new Set(out.tags)];
  out.words = words.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** Any filter at all (a search with only filters lists the runs that match). */
export const hasFilters = (p: ParsedSearch): boolean =>
  p.tags.length > 0 || p.types.length > 0 || p.after !== null || p.before !== null;
