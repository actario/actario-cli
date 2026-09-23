import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actarioEnv, resolveActarioHome } from './env.ts';

/**
 * The rename is only safe if the machine that was linked before it keeps
 * working. These tests are about that promise, not about the new names.
 */

const KEYS = ['ACTARIO_TESTVAR', 'DISTILL_TESTVAR', 'ACTARIO_OTHERVAR', 'DISTILL_OTHERVAR'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('actarioEnv', () => {
  it('reads the new name', () => {
    process.env.ACTARIO_TESTVAR = 'new';
    expect(actarioEnv('TESTVAR')).toBe('new');
  });

  it('falls back to the old name and says so once', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DISTILL_OTHERVAR = 'old';
    expect(actarioEnv('OTHERVAR')).toBe('old');
    expect(actarioEnv('OTHERVAR')).toBe('old');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('DISTILL_OTHERVAR');
  });

  it('prefers the new name when both are set, without a warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ACTARIO_TESTVAR = 'new';
    process.env.DISTILL_TESTVAR = 'old';
    expect(actarioEnv('TESTVAR')).toBe('new');
    expect(err).not.toHaveBeenCalled();
  });

  it('is undefined when neither is set', () => {
    expect(actarioEnv('TESTVAR')).toBeUndefined();
  });
});

describe('resolveActarioHome', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'actario-home-')); });

  it('names ~/.actario on a machine with no history', () => {
    expect(resolveActarioHome(home)).toBe(join(home, '.actario'));
    // Naming it is not creating it: the caller mkdirs when it writes.
    expect(existsSync(join(home, '.actario'))).toBe(false);
  });

  it('moves a pre-rename directory, contents and all', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const legacy = join(home, '.distill');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'salt'), 'the-salt-that-cannot-be-regenerated\n');
    writeFileSync(join(legacy, 'config.json'), '{"version":1,"token":"t"}');

    const resolved = resolveActarioHome(home);

    expect(resolved).toBe(join(home, '.actario'));
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(resolved, 'salt'), 'utf8')).toContain('cannot-be-regenerated');
    expect(readFileSync(join(resolved, 'config.json'), 'utf8')).toContain('"token":"t"');
  });

  it('leaves a pre-rename directory alone once the new one exists', () => {
    const legacy = join(home, '.distill');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'salt'), 'stale\n');
    mkdirSync(join(home, '.actario'), { recursive: true });
    writeFileSync(join(home, '.actario', 'salt'), 'current\n');

    expect(resolveActarioHome(home)).toBe(join(home, '.actario'));
    expect(readFileSync(join(home, '.actario', 'salt'), 'utf8')).toContain('current');
    expect(existsSync(legacy)).toBe(true);
  });
});
