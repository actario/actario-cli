import {
  MEMORY_BUDGET_TOKENS, MEMORY_FORMAT, isUuid, zMemoryBudget,
  type MemoryAnchor, type MemoryBudget, type MemoryScope,
} from './contracts/restore.ts';

/**
 * `actario.memory/v1` (arch v2.1 22.3): one Markdown document.
 *
 *   ---
 *   format: actario.memory/v1
 *   pack_id: 3f0c…                      (uuid; the local folder and the server row share it)
 *   title: "基線重跑工作線"
 *   scope: {"agent":"B1","since":"2026-09-01"}
 *   as_of: 2026-10-07T12:00:00.000Z
 *   budget: M
 *   runs: ["<full run_hash>", …]
 *   client_prompt_version: memory@2026-10-07
 *   ---
 *   > 截至 2026-10-07，涵蓋 3 個 run。
 *
 *   ## 目標
 *   - 把 v3 基線在新切分上重跑一次 (a1b2c3d4e5f6#t3-9)
 *   ## 待完成
 *   - 補 fallback 分支的測試 (a1b2c3d4e5f6#t40-44, 9f8e7d6c5b4a#t2)
 *
 * Front matter values are JSON (which is also YAML flow syntax), so a YAML
 * reader sees the same thing and this parser needs no YAML library -- the CLI
 * bundle ships with zod and the MCP SDK and nothing else.
 *
 * Anchors are `<run_hash or a prefix of it, 8+ chars>#t<from>[-<to>]`. Every
 * content line carries at least one: the pack is lossy, and the anchor is how
 * a reader gets back to what was actually said (22.3 step 4).
 *
 * The same checker runs on the user's machine before saving (`save_memory`)
 * and on the server before storing (POST /memory-packs), so the two cannot
 * disagree about what a valid pack is. The server additionally resolves each
 * anchor against the database (save_memory_pack()).
 */

export interface MemoryFrontMatter {
  format: typeof MEMORY_FORMAT;
  pack_id: string;
  title: string;
  scope: MemoryScope;
  as_of: string;
  budget: MemoryBudget;
  runs: string[];
  client_prompt_version?: string | null;
}

export interface MemoryIssue {
  /** 1-based line of the document; 0 for the document as a whole. */
  line: number;
  code:
    | 'front_matter' | 'missing_section' | 'unanchored_line' | 'unknown_run' | 'ambiguous_run'
    | 'range_not_in_run' | 'over_budget' | 'anchor_mismatch';
  message: string;
}

/** The fixed sections (22.3 step 2), each with the headings that count as it. Goal and to-do are never dropped. */
export const MEMORY_SECTIONS = [
  { key: 'goal', required: true, names: ['目標', '目标', 'goal', 'goals', 'objective'] },
  { key: 'status', required: false, names: ['現況', '现况', 'status', 'current state', 'state'] },
  { key: 'todo', required: true, names: ['待完成', '待办', '待辦', 'to do', 'todo', 'to-do', 'open items', 'remaining', 'next'] },
  { key: 'conventions', required: false, names: ['決定與約定', '决定与约定', '約定', 'decisions and conventions', 'decisions & conventions', 'conventions'] },
  { key: 'files', required: false, names: ['檔案與指令', '文件与命令', 'files and commands', 'files & commands', 'files'] },
  { key: 'pseudonyms', required: false, names: ['假名對照', '假名对照', 'pseudonyms', 'pseudonym legend'] },
] as const;
export type MemorySectionKey = (typeof MEMORY_SECTIONS)[number]['key'];

const ANCHOR_RE = /([A-Za-z0-9][A-Za-z0-9:_.-]{7,199})#t(\d{1,9})(?:-(\d{1,9}))?/g;

/** Rough token count: CJK characters about one token each, everything else about four characters a token. An estimate, said so. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  const other = [...text].length - cjk;
  return Math.ceil(cjk + other / 4);
}

const scalar = (v: string): unknown => {
  const s = v.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (/^[[{"]/.test(s) || /^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false') {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
};

/** Splits off and reads the front matter. Line numbers of the body stay those of the whole document. */
export function parseFrontMatter(doc: string): { fm: Record<string, unknown> | null; bodyStart: number; issues: MemoryIssue[] } {
  const lines = doc.split('\n');
  const issues: MemoryIssue[] = [];
  if (lines[0]?.trim() !== '---') {
    return { fm: null, bodyStart: 0, issues: [{ line: 1, code: 'front_matter', message: 'the document must start with a --- front matter block' }] };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { fm: null, bodyStart: 0, issues: [{ line: 1, code: 'front_matter', message: 'the front matter block is not closed with ---' }] };
  const fm: Record<string, unknown> = {};
  for (let i = 1; i < end; i++) {
    const l = lines[i]!;
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const m = /^([a-z_]+):\s?(.*)$/.exec(l);
    if (!m) { issues.push({ line: i + 1, code: 'front_matter', message: `not a "key: value" line: ${l.slice(0, 60)}` }); continue; }
    fm[m[1]!] = scalar(m[2]!);
  }
  return { fm, bodyStart: end + 1, issues };
}

function validateFrontMatter(fm: Record<string, unknown>): { fm: MemoryFrontMatter | null; issues: MemoryIssue[] } {
  const issues: MemoryIssue[] = [];
  const bad = (message: string) => issues.push({ line: 0, code: 'front_matter', message });
  if (fm.format !== MEMORY_FORMAT) bad(`format must be ${MEMORY_FORMAT}`);
  if (typeof fm.pack_id !== 'string' || !isUuid(fm.pack_id)) bad('pack_id must be a uuid');
  if (typeof fm.title !== 'string' || fm.title.trim().length < 1 || fm.title.length > 200) bad('title must be 1-200 characters');
  if (typeof fm.as_of !== 'string' || Number.isNaN(Date.parse(fm.as_of))) bad('as_of must be an ISO date-time');
  if (!zMemoryBudget.safeParse(fm.budget).success) bad('budget must be S, M or L');
  if (!fm.scope || typeof fm.scope !== 'object' || Array.isArray(fm.scope)) bad('scope must be an object: {"runs"|"agent"|"since"|"until": …}');
  else if (Object.keys(fm.scope).some((k) => !['runs', 'agent', 'since', 'until'].includes(k))) bad('scope may only have runs, agent, since, until');
  if (!Array.isArray(fm.runs) || fm.runs.length === 0 || fm.runs.some((r) => typeof r !== 'string' || r.length < 8)) bad('runs must be a non-empty list of run hashes');
  return { fm: issues.length === 0 ? (fm as unknown as MemoryFrontMatter) : null, issues };
}

const headingKey = (text: string): MemorySectionKey | null => {
  const t = text.trim().toLowerCase().replace(/[：:]+$/, '').trim();
  for (const s of MEMORY_SECTIONS) if ((s.names as readonly string[]).includes(t)) return s.key;
  return null;
};

export interface MemoryCheck {
  frontMatter: MemoryFrontMatter | null;
  /** Every anchor in the document, resolved to the full run_hash from `runs`. */
  anchors: MemoryAnchor[];
  sections: MemorySectionKey[];
  tokens: number;
  budgetTokens: number | null;
  errors: MemoryIssue[];
}

/**
 * Checks a whole document. `opts.runs` (local check): the turn indices of
 * the runs on hand, so their ranges can be checked here. `opts.anchors` (server check): the
 * anchors the client sent; they must be exactly the ones in the text.
 */
export function checkMemoryPack(doc: string, opts: {
  runs?: Map<string, Set<number>>;
  anchors?: MemoryAnchor[];
} = {}): MemoryCheck {
  const errors: MemoryIssue[] = [];
  const { fm: rawFm, bodyStart, issues } = parseFrontMatter(doc);
  errors.push(...issues);
  let fm: MemoryFrontMatter | null = null;
  if (rawFm) {
    const v = validateFrontMatter(rawFm);
    fm = v.fm;
    errors.push(...v.issues);
  }
  const runHashes = fm?.runs ?? [];
  const lines = doc.split('\n');
  const sections = new Set<MemorySectionKey>();
  const anchors: MemoryAnchor[] = [];
  let fence: string | null = null;
  let headedBody = false;

  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const lineNo = i + 1;
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f) { fence = fence === null ? f[1]![0]! : (f[1]![0] === fence ? null : fence); continue; }
    if (fence !== null) continue;
    if (!line) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      headedBody = true;
      const key = headingKey(h[2]!);
      if (key) sections.add(key);
      continue;
    }
    // The header note before the first section ("截至 …，涵蓋 N 個 run") and quotes need no anchor.
    if (!headedBody || line.startsWith('>')) continue;
    // A table's separator row, and the header row above it.
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line)) continue;
    const next = lines[i + 1]?.trim() ?? '';
    if (line.startsWith('|') && /^\|?\s*:?-{3,}/.test(next)) continue;

    const found = [...raw.matchAll(ANCHOR_RE)];
    if (found.length === 0) {
      errors.push({ line: lineNo, code: 'unanchored_line', message: `no anchor (run_hash#tA-B): ${line.slice(0, 60)}` });
      continue;
    }
    for (const m of found) {
      const prefix = m[1]!.toLowerCase();
      const from = Number(m[2]);
      const to = m[3] !== undefined ? Number(m[3]) : from;
      const hits = runHashes.filter((h2) => h2.toLowerCase().startsWith(prefix));
      if (hits.length === 0) {
        errors.push({ line: lineNo, code: 'unknown_run', message: `${m[1]} is not one of the runs in the front matter` });
        continue;
      }
      if (hits.length > 1 && !hits.some((h2) => h2.toLowerCase() === prefix)) {
        errors.push({ line: lineNo, code: 'ambiguous_run', message: `${m[1]} matches ${hits.length} runs; write more of the hash` });
        continue;
      }
      const hash = hits.length === 1 ? hits[0]! : hits.find((h2) => h2.toLowerCase() === prefix)!;
      if (to < from) {
        errors.push({ line: lineNo, code: 'range_not_in_run', message: `${m[0]}: the range ends before it starts` });
        continue;
      }
      // Ranges are checked for the runs whose turns are on hand; the server
      // checks every one against the database anyway.
      const turns = opts.runs?.get(hash);
      if (turns && (!turns.has(from) || !turns.has(to))) {
        errors.push({ line: lineNo, code: 'range_not_in_run', message: `${m[0]}: turn ${!turns.has(from) ? from : to} is not in that run` });
        continue;
      }
      anchors.push({ line: lineNo, run_hash: hash, from, to });
    }
  }

  for (const s of MEMORY_SECTIONS) {
    if (s.required && !sections.has(s.key)) {
      errors.push({ line: 0, code: 'missing_section', message: `the "${s.names[0]}" section (${s.names[2]}) is required and is never dropped` });
    }
  }

  const tokens = estimateTokens(doc);
  const budgetTokens = fm ? MEMORY_BUDGET_TOKENS[fm.budget] : null;
  if (budgetTokens !== null && tokens > budgetTokens) {
    errors.push({ line: 0, code: 'over_budget', message: `about ${tokens} tokens; budget ${fm!.budget} allows ${budgetTokens}. Drop debugging detail first, then finished stages, then file lists, then reasons -- never the goal or the to-do list` });
  }

  if (opts.anchors) {
    const key = (a: MemoryAnchor) => `${a.line}|${a.run_hash}|${a.from}|${a.to}`;
    const inText = new Set(anchors.map(key));
    const sent = new Set(opts.anchors.map(key));
    const missing = [...sent].filter((k) => !inText.has(k));
    const extra = [...inText].filter((k) => !sent.has(k));
    if (missing.length > 0 || extra.length > 0) {
      errors.push({ line: 0, code: 'anchor_mismatch', message: `the anchors sent are not the anchors in the text (${missing.length} not in the text, ${extra.length} not sent)` });
    }
  }

  return { frontMatter: fm, anchors, sections: [...sections], tokens, budgetTokens, errors };
}

/** Writes the front matter block. Values are JSON, so the result reads back through parseFrontMatter unchanged. */
export function renderFrontMatter(fm: MemoryFrontMatter): string {
  const lines = [
    '---',
    `format: ${fm.format}`,
    `pack_id: ${fm.pack_id}`,
    `title: ${JSON.stringify(fm.title)}`,
    `scope: ${JSON.stringify(fm.scope)}`,
    `as_of: ${fm.as_of}`,
    `budget: ${fm.budget}`,
    `runs: ${JSON.stringify(fm.runs)}`,
    ...(fm.client_prompt_version ? [`client_prompt_version: ${fm.client_prompt_version}`] : []),
    '---',
  ];
  return `${lines.join('\n')}\n`;
}

/** The body without its front matter (what goes into a conversation). */
export function memoryBody(doc: string): string {
  const { bodyStart } = parseFrontMatter(doc);
  return doc.split('\n').slice(bodyStart).join('\n').replace(/^\n+/, '');
}
