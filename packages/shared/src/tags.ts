/**
 * Run tags (plan v3.1 ch. 21, arch ch. 28; decided 2026-10-18, #83–#86).
 *
 * Two kinds of tag ride on a run:
 *
 *   facets -- a closed set of values per key (what kind of work, what came
 *             out of it, whether it is a topic that will continue). Stable
 *             enough to filter and count on, and the L2 structure the corpus
 *             plan values most.
 *   free   -- 3–8 short topic words ("京都旅行", "週報", "supabase") for search
 *             and for matching a run to a line.
 *
 * Normalisation lives here, once, because three places must agree on it: the
 * CLI before a DAF is sent, the server gate that stores it, and the web when a
 * person adds a tag. The database re-checks the cheap parts (app.tag_ok) but
 * does not re-implement NFKC.
 */

export const FACET_CATEGORIES = ['daily', 'work', 'recurring', 'learning', 'creative', 'life', 'other'] as const;
export const FACET_TASK_TYPES = ['coding', 'writing', 'research', 'planning', 'analysis', 'learning', 'admin', 'chat'] as const;
export const FACET_OUTPUTS = ['code', 'doc', 'slides', 'sheet', 'image', 'data', 'config', 'none'] as const;
export const FACET_SCOPES = ['topic', 'oneoff'] as const;

export type FacetCategory = (typeof FACET_CATEGORIES)[number];
export type FacetTaskType = (typeof FACET_TASK_TYPES)[number];
export type FacetOutput = (typeof FACET_OUTPUTS)[number];
export type FacetScope = (typeof FACET_SCOPES)[number];

export const TAG_LIMITS = {
  /** Free tags the agent may send per run. */
  freePerRun: 8,
  /** Free tags a run may carry in total, a person's additions included. */
  freeMax: 12,
  /** Characters after normalisation. A CJK tag of 8 characters is the design's ceiling; Latin gets more room for three words. */
  charsMax: 24,
  cjkCharsMax: 8,
  bytesMax: 64,
  newLineNameMax: 40,
} as const;

/**
 * The default categories (#86): created for personal paid plans (Lite and up),
 * never for Free. The key is the identity; the name is only the starting label
 * and the user may rename it. Seed tags give an empty category something to
 * match on before any run has landed in it.
 */
export const DEFAULT_CATEGORIES = [
  { key: 'daily', zh: '日常記事', en: 'Daily notes', seeds: ['雜記', '問答', '隨手', '生活', 'notes', 'daily'] },
  { key: 'work', zh: '工作紀要', en: 'Work log', seeds: ['會議', '報告', 'email', '簡報', '客戶', 'meeting', 'report'] },
  { key: 'recurring', zh: '定期工作', en: 'Recurring tasks', seeds: ['週報', '月報', '例行', '對帳', '排程', 'weekly', 'monthly'] },
  { key: 'learning', zh: '學習研究', en: 'Learning & research', seeds: ['讀書', '課程', '論文', '考試', '研究', 'study', 'paper'] },
  { key: 'creative', zh: '創作寫作', en: 'Writing & creative', seeds: ['文章', '文案', '腳本', '設計', '靈感', 'writing', 'design'] },
  { key: 'life', zh: '生活規劃', en: 'Life planning', seeds: ['旅行', '搬家', '行程', '購物', '預算', 'travel', 'trip'] },
] as const;
export type CategoryKey = (typeof DEFAULT_CATEGORIES)[number]['key'];
export const CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c.key) as readonly CategoryKey[];
export const isCategoryKey = (k: unknown): k is CategoryKey => typeof k === 'string' && (CATEGORY_KEYS as readonly string[]).includes(k);

/**
 * Plans whose workspaces get the default categories. None since 2026-10-23
 * (Jacky: the defaults are retired; unfiled runs wait in 未分類). Was #86:
 * Lite and up. Kept as a seam rather than deleted, with migration
 * 20261023000100 turning app.categories_enabled off in the database.
 */
export const CATEGORY_PLANS: readonly string[] = [];
export const planHasCategories = (plan: string | null | undefined): boolean =>
  !!plan && (CATEGORY_PLANS as readonly string[]).includes(plan);

/** Words that say nothing about a run. Compared after normalisation. */
const EMPTY_WORDS = new Set([
  '對話', '問題', '討論', '聊天', '幫忙', '其他', '一般', '東西', '內容', '筆記',
  'chat', 'conversation', 'question', 'questions', 'help', 'misc', 'other', 'general', 'stuff', 'ai', 'claude', 'chatgpt', 'gpt', 'llm', 'note', 'notes',
]);

/** A pseudonym the local redaction wrote (`USER-1A2B3C`, `KEY-…`), lower-cased by normalisation. */
const PSEUDONYM = /(^|[^a-z0-9])[a-z]{2,6}-[0-9a-f]{6}($|[^a-z0-9])/;
const LOOKS_LIKE_CONTACT = /@|:\/\/|www\.|\.(com|net|org|io|app|dev|tw)(\/|$)/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/g;

/**
 * NFKC → lower case → strip a leading `#` and edge punctuation → collapse
 * whitespace. Returns '' for something that is not a tag at all.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#＃]+/, '')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
}

export type TagRejection = 'empty' | 'too_long' | 'pseudonym' | 'contact' | 'control' | 'vague';

/** Why a normalised tag may not be stored, or null if it may. */
export function tagProblem(norm: string): TagRejection | null {
  if (!norm) return 'empty';
  if (CONTROL.test(norm)) return 'control';
  const cjk = norm.match(CJK)?.length ?? 0;
  if ([...norm].length > TAG_LIMITS.charsMax || (cjk > 0 && cjk > TAG_LIMITS.cjkCharsMax) || new TextEncoder().encode(norm).length > TAG_LIMITS.bytesMax) return 'too_long';
  if (PSEUDONYM.test(norm)) return 'pseudonym';
  if (LOOKS_LIKE_CONTACT.test(norm)) return 'contact';
  if (EMPTY_WORDS.has(norm)) return 'vague';
  return null;
}

export interface CleanTag { norm: string; display: string }

/**
 * The tags worth keeping, deduplicated on the normalised form, in order, up
 * to `max`. `display` keeps the writer's spelling (trimmed and NFKC'd, case
 * kept) so "Supabase" still reads as written.
 */
export function cleanTags(raw: readonly string[], max: number = TAG_LIMITS.freePerRun): { tags: CleanTag[]; rejected: { tag: string; why: TagRejection }[] } {
  const seen = new Set<string>();
  const tags: CleanTag[] = [];
  const rejected: { tag: string; why: TagRejection }[] = [];
  for (const t of raw) {
    const norm = normalizeTag(t);
    const why = tagProblem(norm);
    if (why) { rejected.push({ tag: t, why }); continue; }
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (tags.length >= max) continue;
    const display = t.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^[#＃]+/, '').trim();
    tags.push({ norm, display: normalizeTag(display) === norm ? display : norm });
  }
  return { tags, rejected };
}

export interface Facets {
  category: FacetCategory | null;
  task_type: FacetTaskType | null;
  outputs: FacetOutput[];
  scope: FacetScope | null;
}

/** Facets as stored: one row per value, keyed by facet. */
export function facetRows(f: Partial<Facets> | null | undefined): { facet_key: string; value: string }[] {
  if (!f) return [];
  const out: { facet_key: string; value: string }[] = [];
  if (f.category) out.push({ facet_key: 'category', value: f.category });
  if (f.task_type) out.push({ facet_key: 'task_type', value: f.task_type });
  for (const o of [...new Set(f.outputs ?? [])]) out.push({ facet_key: 'outputs', value: o });
  if (f.scope) out.push({ facet_key: 'scope', value: f.scope });
  return out;
}

/** Display labels for facet values, zh and en. Unknown values fall back to the value itself. */
export const FACET_LABELS: Record<string, { zh: string; en: string }> = {
  daily: { zh: '日常', en: 'Daily' }, work: { zh: '工作', en: 'Work' }, recurring: { zh: '定期', en: 'Recurring' },
  learning: { zh: '學習', en: 'Learning' }, creative: { zh: '創作', en: 'Creative' }, life: { zh: '生活', en: 'Life' }, other: { zh: '其他', en: 'Other' },
  coding: { zh: '寫程式', en: 'Coding' }, writing: { zh: '寫作', en: 'Writing' }, research: { zh: '研究', en: 'Research' },
  planning: { zh: '規劃', en: 'Planning' }, analysis: { zh: '分析', en: 'Analysis' }, admin: { zh: '行政', en: 'Admin' }, chat: { zh: '聊天', en: 'Chat' },
  code: { zh: '程式', en: 'Code' }, doc: { zh: '文件', en: 'Doc' }, slides: { zh: '簡報', en: 'Slides' }, sheet: { zh: '表格', en: 'Sheet' },
  image: { zh: '圖片', en: 'Image' }, data: { zh: '資料', en: 'Data' }, config: { zh: '設定', en: 'Config' }, none: { zh: '沒有產出', en: 'No output' },
  topic: { zh: '主題', en: 'Ongoing' }, oneoff: { zh: '一次性', en: 'One-off' },
};
