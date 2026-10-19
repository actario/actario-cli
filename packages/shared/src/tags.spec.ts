import { describe, expect, it } from 'vitest';
import { cleanTags, facetRows, normalizeTag, planHasCategories, tagProblem } from './tags.ts';

describe('normalizeTag', () => {
  it('NFKC, lower case, strips # and edge punctuation, collapses spaces', () => {
    expect(normalizeTag('  #Supabase  ')).toBe('supabase');
    expect(normalizeTag('ＡＢＣ')).toBe('abc');
    expect(normalizeTag('「京都旅行」')).toBe('京都旅行');
    expect(normalizeTag('weekly   report!')).toBe('weekly report');
    expect(normalizeTag('＃週報')).toBe('週報');
  });
});

describe('tagProblem', () => {
  it('refuses pseudonyms, contacts, control characters, vague and long tags', () => {
    expect(tagProblem('user-1a2b3c')).toBe('pseudonym');
    expect(tagProblem('寄給 key-00ff11')).toBe('pseudonym');
    expect(tagProblem('a@b.c')).toBe('contact');
    expect(tagProblem('https://x.y')).toBe('contact');
    expect(tagProblem('example.com')).toBe('contact');
    expect(tagProblem('對話')).toBe('vague');
    expect(tagProblem('chat')).toBe('vague');
    expect(tagProblem('一二三四五六七八九')).toBe('too_long');
    expect(tagProblem('x'.repeat(25))).toBe('too_long');
    expect(tagProblem('a\u0007b')).toBe('control');
    expect(tagProblem('')).toBe('empty');
  });
  it('keeps ordinary tags', () => {
    for (const t of ['京都旅行', '週報', 'supabase', 'rls policy', 'q3 budget']) expect(tagProblem(t)).toBeNull();
  });
});

describe('cleanTags', () => {
  it('dedupes on the normalised form, keeps the writer spelling, caps the count', () => {
    const r = cleanTags(['Supabase', 'supabase', '#週報', '對話', 'USER-ABCDEF', 'a', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1'], 8);
    expect(r.tags[0]).toEqual({ norm: 'supabase', display: 'Supabase' });
    expect(r.tags[1]).toEqual({ norm: '週報', display: '週報' });
    expect(r.tags).toHaveLength(8);
    expect(r.rejected.map((x) => x.why)).toEqual(['vague', 'pseudonym']);
  });
});

describe('facetRows / planHasCategories', () => {
  it('one row per facet value', () => {
    expect(facetRows({ category: 'work', task_type: 'planning', outputs: ['doc', 'doc', 'slides'], scope: 'topic' })).toEqual([
      { facet_key: 'category', value: 'work' }, { facet_key: 'task_type', value: 'planning' },
      { facet_key: 'outputs', value: 'doc' }, { facet_key: 'outputs', value: 'slides' }, { facet_key: 'scope', value: 'topic' },
    ]);
    expect(facetRows(null)).toEqual([]);
  });
  it('Free has no categories; Lite and up do; org plans not yet', () => {
    expect(planHasCategories('free')).toBe(false);
    // Retired 2026-10-23: no plan gets the default categories.
    expect(planHasCategories('lite')).toBe(false);
    expect(planHasCategories('internal')).toBe(false);
    expect(planHasCategories('team')).toBe(false);
    expect(planHasCategories(null)).toBe(false);
  });
});
