import { describe, expect, it } from 'vitest';
import { hasFilters, parseSearch } from './search-query.ts';

describe('parseSearch', () => {
  it('splits words from filters', () => {
    const p = parseSearch('秋季 定價 tag:週報 #記帳 line:工作紀要 kind:page,file type:doc after:2026-09 before:2026-10-15');
    expect(p).toEqual({
      words: '秋季 定價', tags: ['週報', '記帳'], line: '工作紀要', kinds: ['pages', 'outputs'], types: ['doc'],
      after: '2026-09-01', before: '2026-10-15', unknown: [],
    });
    expect(hasFilters(p)).toBe(true);
  });
  it('keeps quoted phrases and quoted values together', () => {
    expect(parseSearch('"use client" tag:"Weekly Report" line:"Distill conversations"')).toMatchObject({
      words: 'use client', tags: ['weekly report'], line: 'Distill conversations',
    });
  });
  it('leaves colons that are not filters alone, and reports filters it cannot read', () => {
    expect(parseSearch('12:30 開會 https://x.y/a C:\\Users').words).toBe('12:30 開會 https://x.y/a C:\\Users');
    expect(parseSearch('foo:bar').words).toBe('foo:bar');
    const bad = parseSearch('kind:galaxy type:video after:yesterday 預算');
    expect(bad.unknown).toEqual(['kind:galaxy', 'type:video', 'after:yesterday']);
    expect(bad.words).toBe('預算');
    expect(hasFilters(bad)).toBe(false);
  });
  it('accepts Chinese kind names and years', () => {
    expect(parseSearch('kind:產出,記憶 before:2026').kinds).toEqual(['outputs', 'memory']);
    expect(parseSearch('before:2026').before).toBe('2026-01-01');
    expect(parseSearch('after:2026-13').unknown).toEqual(['after:2026-13']);
    expect(parseSearch('after:2026-02-31').unknown).toEqual(['after:2026-02-31']);
  });
});
