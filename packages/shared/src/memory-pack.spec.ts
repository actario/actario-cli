import { describe, expect, it } from 'vitest';
import {
  checkMemoryPack, estimateTokens, memoryBody, parseFrontMatter, renderFrontMatter, type MemoryFrontMatter,
} from './memory-pack.ts';
import { parseRunRef, zMemoryPackSave, zTranscriptQuery } from './contracts/restore.ts';

const H1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const H2 = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';
const fm = (over: Partial<MemoryFrontMatter> = {}): MemoryFrontMatter => ({
  format: 'actario.memory/v1', pack_id: '3f0c2a8e-1d2b-4c3d-8e4f-5a6b7c8d9e0f', title: '基線重跑工作線',
  scope: { agent: 'B1', since: '2026-09-01' }, as_of: '2026-10-07T04:00:00.000Z', budget: 'M',
  runs: [H1, H2], client_prompt_version: 'memory@2026-10-07', ...over,
});
const body = [
  '> 截至 2026-10-07，涵蓋 2 個 run。',
  '',
  '## 目標',
  '- 把 v3 基線在 LOPO 切分上重跑一次 (a1b2c3d4e5f6#t3-9)',
  '',
  '## 現況',
  '| 階段 | 狀態 |',
  '|---|---|',
  '| 切分 | 完成（10-03，a1b2c3d4e5f6#t10-12） |',
  '',
  '## 待完成',
  '- 補 fallback 分支的測試 (a1b2c3d4e5f6#t12, 9f8e7d6c#t2-4)',
  '',
  '## 檔案與指令',
  '```bash',
  'npm run eval -- --split lopo',
  '```',
  '- 上面的指令在 9f8e7d6c#t4 定下',
].join('\n');
const doc = (f = fm(), b = body) => `${renderFrontMatter(f)}${b}\n`;
const turns = new Map([[H1, new Set([3, 9, 10, 12])], [H2, new Set([2, 4])]]);

describe('checkMemoryPack', () => {
  it('accepts a well-formed pack and resolves every anchor to the full run hash, by document line', () => {
    const r = checkMemoryPack(doc(), { runs: turns });
    expect(r.errors).toEqual([]);
    expect(r.sections).toEqual(['goal', 'status', 'todo', 'files']);
    expect(r.anchors).toEqual([
      { line: 14, run_hash: H1, from: 3, to: 9 },
      { line: 19, run_hash: H1, from: 10, to: 12 },
      { line: 22, run_hash: H1, from: 12, to: 12 },
      { line: 22, run_hash: H2, from: 2, to: 4 },
      { line: 28, run_hash: H2, from: 4, to: 4 },
    ]);
    expect(r.frontMatter?.runs).toEqual([H1, H2]);
  });

  it('reports a content line with no anchor, but not headings, the header note, code, or a table header', () => {
    const r = checkMemoryPack(doc(fm(), body.replace('- 把 v3 基線在 LOPO 切分上重跑一次 (a1b2c3d4e5f6#t3-9)', '- 把 v3 基線重跑一次')), { runs: turns });
    expect(r.errors).toEqual([expect.objectContaining({ line: 14, code: 'unanchored_line' })]);
  });

  it('requires the goal and to-do sections, in either language', () => {
    const noTodo = body.replace('## 待完成', '## 雜項');
    expect(checkMemoryPack(doc(fm(), noTodo)).errors.map((e) => e.code)).toContain('missing_section');
    const english = body.replace('## 目標', '## Goal').replace('## 待完成', '## To do');
    expect(checkMemoryPack(doc(fm(), english)).errors).toEqual([]);
  });

  it('refuses anchors to runs not in the front matter, ambiguous prefixes, and turns the run does not have', () => {
    const r = checkMemoryPack(doc(fm({ runs: [H1, `${H1.slice(0, 20)}ffff`] }), body), { runs: turns });
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('ambiguous_run');
    expect(codes).toContain('unknown_run');
    const r2 = checkMemoryPack(doc(fm(), body.replace('#t3-9', '#t3-99')), { runs: turns });
    expect(r2.errors).toEqual([expect.objectContaining({ line: 14, code: 'range_not_in_run' })]);
  });

  it('checks the front matter', () => {
    const bad = checkMemoryPack(doc(fm({ budget: 'XL' as 'M', pack_id: 'nope', runs: [] })));
    expect(bad.errors.filter((e) => e.code === 'front_matter').map((e) => e.message)).toEqual([
      'pack_id must be a uuid', 'budget must be S, M or L', 'runs must be a non-empty list of run hashes',
    ]);
    expect(checkMemoryPack('## 目標\n- x').errors[0]).toMatchObject({ code: 'front_matter' });
  });

  it('enforces the budget', () => {
    const long = `${body}\n${Array.from({ length: 2100 }, (_, i) => `- 第 ${i} 項 (a1b2c3d4e5f6#t3)`).join('\n')}`;
    const r = checkMemoryPack(doc(fm({ budget: 'S' }), long));
    expect(r.errors.map((e) => e.code)).toEqual(['over_budget']);
    expect(r.tokens).toBeGreaterThan(2000);
  });

  it('on the server, the anchors sent must be exactly those in the text', () => {
    const local = checkMemoryPack(doc());
    expect(checkMemoryPack(doc(), { anchors: local.anchors }).errors).toEqual([]);
    const tampered = local.anchors.map((a, i) => (i === 0 ? { ...a, to: 99 } : a));
    expect(checkMemoryPack(doc(), { anchors: tampered }).errors.map((e) => e.code)).toEqual(['anchor_mismatch']);
  });
});

describe('front matter round trip', () => {
  it('renders JSON values that parse back unchanged', () => {
    const { fm: back, bodyStart } = parseFrontMatter(doc());
    expect(back).toEqual(fm());
    expect(bodyStart).toBe(10); // 0-based index of the first body line
    expect(memoryBody(doc()).startsWith('> 截至')).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('counts CJK about a token a character and the rest about four characters a token', () => {
    expect(estimateTokens('目標目標')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });
});

describe('contracts', () => {
  it('parseRunRef takes ids, run URLs, hashes and hash prefixes', () => {
    const id = '7a3f0c2a-1d2b-4c3d-8e4f-5a6b7c8d9e0f';
    expect(parseRunRef(id.toUpperCase())).toEqual({ kind: 'id', id });
    expect(parseRunRef(`https://actario.app/runs/${id}/note`)).toEqual({ kind: 'id', id });
    expect(parseRunRef(H1)).toEqual({ kind: 'hash', hash: H1 });
    expect(parseRunRef('A1B2C3D4E5F6')).toEqual({ kind: 'hash', hash: 'a1b2c3d4e5f6' });
    expect(parseRunRef('claude_code:sess-123')).toEqual({ kind: 'hash', hash: 'claude_code:sess-123' });
    for (const bad of ['', 'abc', 'a1b2c3', 'hello world', '../etc']) expect(parseRunRef(bad)).toBeNull();
  });

  it('zTranscriptQuery reads include as a set of known names', () => {
    expect(zTranscriptQuery.parse({ include: 'page,segments,page' }).include).toEqual(['page', 'segments']);
    expect(zTranscriptQuery.parse({}).include).toEqual([]);
    expect(zTranscriptQuery.safeParse({ include: 'diffs' }).success).toBe(false);
    expect(zTranscriptQuery.safeParse({ limit: '501' }).success).toBe(false);
  });

  it('zMemoryPackSave refuses a scope with unknown keys and a reversed anchor', () => {
    const base = {
      pack_id: fm().pack_id, base_version: 0, title: 't', scope: { agent: 'B1' }, as_of: '2026-10-07T00:00:00Z',
      budget: 'M', body: 'x', anchors: [{ line: 1, run_hash: H1, from: 0, to: 1 }],
    };
    expect(zMemoryPackSave.safeParse(base).success).toBe(true);
    expect(zMemoryPackSave.safeParse({ ...base, scope: { workspace: 'x' } }).success).toBe(false);
    expect(zMemoryPackSave.safeParse({ ...base, anchors: [{ line: 1, run_hash: H1, from: 2, to: 1 }] }).success).toBe(false);
  });
});
