import { describe, expect, it } from 'vitest';
import { buildProfile, decideLine, nameSimilarity, nameWords, scoreLines, tagSimilarity, type LineProfile } from './line-match.ts';
import { DEFAULT_CATEGORIES } from './tags.ts';

const topic = (id: string, name: string, w: Record<string, number> = {}): LineProfile => buildProfile({ id, name, lineKind: 'topic', categoryKey: null }, w);
const cats: LineProfile[] = DEFAULT_CATEGORIES.map((c) => buildProfile({ id: `cat-${c.key}`, name: c.zh, lineKind: 'category', categoryKey: c.key }, {}, c.seeds));
const lines: LineProfile[] = [
  topic('kyoto', '京都旅行', { 京都: 3, 行程: 2, 預算: 1 }),
  topic('distill', 'Distill conversations', { supabase: 4, rls: 3, migration: 2, 'next.js': 1 }),
  topic('ledger', '記帳本', { 記帳: 3, 預算: 2, 九月: 1 }),
  ...cats,
];

describe('helpers', () => {
  it('nameWords drops the "conversations" suffix', () => {
    expect(nameWords('Distill conversations')).toEqual(['distill']);
    expect(nameWords('京都旅行')).toEqual(['京都旅行']);
  });
  it('tagSimilarity: equal, CJK containment, Latin whole words only', () => {
    expect(tagSimilarity('京都', '京都旅行')).toBe(0.7);
    expect(tagSimilarity('rls', 'rls policy')).toBe(0.5);
    expect(tagSimilarity('art', 'start')).toBe(0);
    expect(tagSimilarity('a', 'abc')).toBe(0);
  });
  it('nameSimilarity', () => {
    expect(nameSimilarity('京都旅行', '京都旅遊')).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity('Distill conversations', 'distill')).toBe(1);
    expect(nameSimilarity('京都旅行', '記帳本')).toBe(0);
  });
});

describe('scoreLines', () => {
  it('ranks the line that shares the rare tags first', () => {
    const s = scoreLines({ tags: ['supabase', 'rls', 'policy'] }, lines);
    expect(s[0]!.id).toBe('distill');
    expect(s[0]!.score).toBeGreaterThan(0.45);
    expect(s[0]!.reasons[0]!.tag).toBe('supabase');
  });
  it('containment counts for CJK', () => {
    const s = scoreLines({ tags: ['京都行程', '住宿'] }, lines);
    expect(s[0]!.id).toBe('kyoto');
  });
  it('nothing in common scores 0', () => {
    expect(scoreLines({ tags: ['量子力學'] }, lines).every((x) => x.score === 0)).toBe(true);
    expect(scoreLines({ tags: [] }, lines).every((x) => x.score === 0)).toBe(true);
  });
});

const base = { category: null, scope: null, strength: 'model' as const, hint: null, lines, categoriesEnabled: true };

describe('decideLine', () => {
  it('an existing topic line when alike', () => {
    const d = decideLine({ ...base, tags: ['supabase', 'rls', 'migration'] });
    expect(d).toMatchObject({ action: 'existing', agentId: 'distill', method: 'formula', needsReview: false });
  });
  it('the agent hint wins when the line is one the run may go to', () => {
    expect(decideLine({ ...base, tags: ['supabase'], hint: { agentId: 'ledger' } })).toMatchObject({ action: 'existing', agentId: 'ledger', method: 'hint' });
    // An id the caller cannot file into is ignored, not trusted.
    expect(decideLine({ ...base, tags: ['supabase', 'rls'], hint: { agentId: 'someone-elses' } })).toMatchObject({ agentId: 'distill', method: 'formula' });
  });
  it('a proposed new name that nearly matches a line is that line', () => {
    expect(decideLine({ ...base, tags: ['住宿'], scope: 'topic', hint: { newName: '京都旅遊' } })).toMatchObject({ action: 'existing', agentId: 'kyoto' });
  });
  it('a new line for a continuing topic nobody has', () => {
    expect(decideLine({ ...base, tags: ['婚禮', '場地'], scope: 'topic' })).toEqual({ action: 'new', name: '婚禮 場地', method: 'new_line', reasons: [] });
    expect(decideLine({ ...base, tags: ['婚禮'], scope: 'topic', hint: { newName: '婚禮籌備' } })).toMatchObject({ action: 'new', name: '婚禮籌備' });
  });
  it('a one-off goes to its category', () => {
    expect(decideLine({ ...base, tags: ['天氣'], category: 'daily', scope: 'oneoff' })).toMatchObject({ action: 'category', agentId: 'cat-daily' });
  });
  it('Free: no categories -- a one-off stays unfiled; a topic still opens a line', () => {
    const free = { ...base, categoriesEnabled: false };
    expect(decideLine({ ...free, tags: ['天氣'], category: 'daily', scope: 'oneoff' })).toEqual({ action: 'unbound', suggestedName: null });
    expect(decideLine({ ...free, tags: ['婚禮'], scope: 'topic' })).toMatchObject({ action: 'new' });
  });
  it('#45: guessed (mechanical) tags never open a line', () => {
    expect(decideLine({ ...base, tags: ['婚禮'], scope: 'topic', strength: 'mech', categoriesEnabled: false })).toEqual({ action: 'unbound', suggestedName: '婚禮' });
  });
  it('without a facet, a category is still chosen when the tags plainly say so', () => {
    expect(decideLine({ ...base, tags: ['週報', '例行'] })).toMatchObject({ action: 'category', agentId: 'cat-recurring' });
  });
  it('weak likeness files it but asks for a check', () => {
    const d = decideLine({ ...base, tags: ['記帳', '房租', '水電'], lines: [topic('ledger', '記帳本', { 記帳: 3, 預算: 2 }), topic('kyoto', '京都旅行', { 京都: 3 })] });
    expect(d.action).toBe('existing');
    if (d.action === 'existing') expect(d.needsReview).toBe(true);
  });
});
