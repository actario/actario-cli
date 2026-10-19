import { describe, expect, it } from 'vitest';
import { RedactionEngine } from '@distill/redaction';
import { maskQuery, unmaskHits } from './core/search-local.ts';

/** arch 28.7: a query with real names is masked on this machine, and what comes back is unmasked here. */
const reverse = new Map([['USER-1A2B3C', '王小明'], ['USER-0F0F0F', 'Wang Xiaoming Lab'], ['USER-ABCDEF', 'Wang']]);

describe('maskQuery', () => {
  it('swaps every known original for its pseudonym, longest first, case-insensitively', () => {
    expect(maskQuery('王小明 秋季報價', reverse)).toEqual({ q: 'USER-1A2B3C 秋季報價', replaced: 1 });
    expect(maskQuery('wang xiaoming lab and wang', reverse)).toEqual({ q: 'USER-0F0F0F and USER-ABCDEF', replaced: 2 });
    expect(maskQuery('nothing here', null)).toEqual({ q: 'nothing here', replaced: 0 });
  });
  it('never touches parts of other words, its own replacements, or filter values', () => {
    const r = new Map([['USER-111111', 'Li'], ['ORG-222222', 'Ann'], ['USER-333333', 'se'], ['USER-444444', '工作紀要']]);
    expect(maskQuery('linux client annual Li', r)).toEqual({ q: 'linux client annual USER-111111', replaced: 1 });
    expect(maskQuery('Ann se', r)).toEqual({ q: 'ORG-222222 USER-333333', replaced: 2 });
    expect(maskQuery('會議 line:工作紀要 tag:Li #Ann', r)).toEqual({ q: '會議 line:工作紀要 tag:Li #Ann', replaced: 0 });
  });

  it('also runs the local rules, so a fresh email becomes the same pseudonym capture would give it', () => {
    const engine = new RedactionEngine({ profile: 'general', salt: 's' });
    const r = maskQuery('寄給 ops@example.com 的信', null, engine);
    expect(r.q).not.toContain('ops@example.com');
    expect(r.replaced).toBe(1);
    expect(r.q).toBe(engine.redactText('寄給 ops@example.com 的信').text);
    const f = maskQuery('ops@example.com line:"ops@example.com"', null, engine);
    expect(f.q.endsWith('line:"ops@example.com"')).toBe(true);
    expect(f.q.startsWith('ops@example.com')).toBe(false);
  });
});

describe('unmaskHits', () => {
  it('unmasks the named fields only', () => {
    const hits = [{ run_id: 'USER-1A2B3C', snippet: '問 USER-1A2B3C 報價', title: 'x' }];
    expect(unmaskHits(hits, reverse, ['snippet'])).toEqual([{ run_id: 'USER-1A2B3C', snippet: '問 王小明 報價', title: 'x' }]);
    expect(unmaskHits(undefined, reverse, ['snippet'])).toEqual([]);
  });
});
