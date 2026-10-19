import { describe, expect, it } from 'vitest';
import { alignCapture, conversationKey, leadPrint, normalizeForPrint, userPrint, userPrints } from './conversation.ts';

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });
const stored = (turns: { role: string; content: string }[]) => {
  const lastUser = turns.map((t) => t.role).lastIndexOf('user');
  return { userPrints: userPrints(turns), turnCount: turns.length, tail: turns.length - 1 - lastUser };
};

describe('prints', () => {
  it('ignores whitespace shape and Unicode composition, not wording', () => {
    expect(normalizeForPrint('  hello\n\n  world　 ')).toBe('hello world');
    expect(userPrint('café')).toBe(userPrint('café'));
    expect(userPrint('hello world')).toBe(userPrint('hello   world\n'));
    expect(userPrint('hello world')).not.toBe(userPrint('hello, world'));
  });

  it('only counts user turns, and needs two for a lead', () => {
    const t = [u('one'), a('reply'), u('two'), a('reply 2')];
    expect(userPrints(t)).toHaveLength(2);
    expect(leadPrint(userPrints(t))).toMatch(/^[0-9a-f]{32}$/);
    expect(leadPrint(userPrints([u('only')]))).toBeNull();
  });

  it('keys the same conversation differently per workspace', () => {
    const k1 = conversationKey('ws-1', 'cowork', 'session_01');
    expect(k1).toBe(conversationKey('ws-1', 'cowork', 'session_01'));
    expect(k1).not.toBe(conversationKey('ws-2', 'cowork', 'session_01'));
    expect(k1).not.toBe(conversationKey('ws-1', 'claude_code', 'session_01'));
  });
});

describe('alignCapture', () => {
  const first = [u('plan the B2 split'), a('here is a plan'), u('use LOSO'), a('done')];

  it('appends what came after the stored copy', () => {
    const later = [...first, u('now tune the GP'), a('tuned')];
    expect(alignCapture(stored(first), later)).toEqual({ kind: 'append', from: 4 });
  });

  it('re-sending the same capture, or an earlier part of it, adds nothing', () => {
    expect(alignCapture(stored(first), first)).toEqual({ kind: 'noop' });
    expect(alignCapture(stored(first), first.slice(0, 2))).toEqual({ kind: 'noop' });
  });

  it('keeps a stored reply that was still being written and appends only what follows', () => {
    const half = [u('plan the B2 split'), a('here is a plan'), u('use LOSO')];
    const later = [...first, u('next'), a('ok')];
    // stored ended on the user turn (tail 0): the reply at idx 3 is new
    expect(alignCapture(stored(half), later)).toEqual({ kind: 'append', from: 3 });
  });

  it('cuts by user turns, so assistant turns written differently do not matter', () => {
    const rewritten = [u('plan the B2 split'), a('A DIFFERENT PLAN TEXT'), u('use LOSO'), a('finished'), u('more'), a('x')];
    expect(alignCapture(stored(first), rewritten)).toEqual({ kind: 'append', from: 4 });
  });

  it('follows the stored tail when the incoming capture split replies differently', () => {
    const storedTurns = [u('q1'), a('a1'), { role: 'tool', content: 'out' }, a('a1b')];
    const incoming = [u('q1'), a('a1 in one piece'), u('q2'), a('a2')];
    // stored has 3 turns after its last user turn; incoming has only 1 before q2: the cut stops at q2
    expect(alignCapture(stored(storedTurns), incoming)).toEqual({ kind: 'append', from: 2 });
  });

  it('a user turn that differs is a different conversation (or a rewritten one)', () => {
    const other = [u('plan the B2 split'), a('...'), u('use k-fold'), a('...'), u('x'), a('y')];
    expect(alignCapture(stored(first), other)).toEqual({ kind: 'diverged' });
  });
});
