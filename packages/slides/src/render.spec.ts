import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { clip, plain, renderDeck, widthOf, zDeckSpec } from './index.ts';

const slidesIn = async (buf: Buffer) => {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const text = (await Promise.all(names.map((n) => zip.file(n)!.async('string')))).join('\n');
  const notes = Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const notesText = (await Promise.all(notes.map((n) => zip.file(n)!.async('string')))).join('\n');
  return { count: names.length, text, notesText };
};

describe('renderDeck', () => {
  it('writes a cover plus one slide per spec slide, with the words and the notes', async () => {
    const buf = await renderDeck({
      title: '上傳逾時修正', lang: 'zh',
      slides: [
        { kind: 'conclusion', stoppedAt: 'push 之前', done: ['修好逾時 (#3–5)'], todo: [] },
        { kind: 'stages', stages: [{ name: '修逾時', status: '完成', tone: 'done', start: 0, end: 4 }], turnCount: 10 },
        { kind: 'stage', heading: '修逾時', slot: 1, left: { label: '做成了', items: ['改成 **分段**'] }, notes: '單次上傳超過上限' },
        { kind: 'timeline', items: [{ date: '2026-10-14', title: 'x', done: 1, total: 2 }] },
        { kind: 'bullets', heading: 'b', bullets: ['one'] },
      ],
    });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const { count, text, notesText } = await slidesIn(buf);
    expect(count).toBe(6);
    expect(text).toContain('上傳逾時修正');
    expect(text).toContain('修好逾時');
    expect(text).not.toContain('(#3–5)');        // the turn pointer means nothing on a slide
    expect(text).not.toContain('**');
    expect(text).toContain('由筆記頁組成');
    expect(notesText).toContain('單次上傳超過上限');
  });

  it('refuses a spec that is not one', () => {
    expect(zDeckSpec.safeParse({ title: '', slides: [] }).success).toBe(false);
    expect(zDeckSpec.safeParse({ title: 't', slides: [{ kind: 'video' }] }).success).toBe(false);
  });
});

describe('what a page can hold', () => {
  it('strips control characters (an ANSI escape would corrupt the XML) and clips long text instead of failing', async () => {
    const long = '很長的一句話'.repeat(30);   // 180 characters: within the spec, far past a slide
    const buf = await renderDeck({
      title: `T\u001b[31m${long}`, lang: 'zh',
      slides: [
        { kind: 'conclusion', lede: long, stoppedAt: long, done: Array.from({ length: 30 }, (_, i) => `${i} ${long}`), todo: [] },
        { kind: 'stages', stages: Array.from({ length: 14 }, (_, i) => ({ name: `s${i} ${long}`, status: '完成', tone: 'done' as const, brief: long })) },
        { kind: 'bullets', heading: long, bullets: [long], notes: `x\u0000y\u000b${long}` },
      ],
    });
    const { text, notesText } = await slidesIn(buf);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(notesText).not.toMatch(/[\u0000\u000b]/);
    expect(text).toContain('…還有');
  });
  it('builds no $ref into the JSON an MCP client sees', async () => {
    const { zodToJsonSchema } = await import('zod-to-json-schema');
    expect(JSON.stringify(zodToJsonSchema(zDeckSpec))).not.toContain('$ref');
  });
});

describe('text helpers', () => {
  it('clips by code point and strips Markdown marks and trailing pointers', () => {
    expect(clip('一二三四五', 7)).toBe('一二三…');     // CJK counts 2
    expect(clip('ok', 4)).toBe('ok');
    expect(widthOf('ab一')).toBe(4);
    expect(plain('改成 `chunked` **上傳** (#12–18)')).toBe('改成 chunked 上傳');
    expect(plain('`__init__.py`')).toBe('__init__.py');
  });
});
