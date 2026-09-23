import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Process-boundary smoke tests.
 *
 * Every other test in this repo imports functions. These run the CLI the way a
 * user does -- as a child process with stdout on a pipe -- because that is the
 * only way to catch a class of bug that lives entirely at the boundary.
 *
 * The bug that prompted this file: `process.exit()` discards buffered stdout.
 * With stdout on a TTY (POSIX) the buffer is always empty and everything looks
 * fine; through `npm run` on Windows the report was thrown away and the CLI
 * printed nothing at all. Asserting on non-empty piped output is cheap and it
 * fails loudly if the flush is ever removed.
 *
 * The lint rule in eslint.config.js is the portable half of the guard, since a
 * POSIX CI runner cannot reproduce the Windows pipe behaviour.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** What `npm run` and `npx distill` actually execute. */
const BIN = resolve(HERE, '../bin/actario.js');
/** The module itself, which must also work when invoked directly. */
const MODULE = resolve(HERE, 'index.ts');

function runCli(args: string[], env: Record<string, string> = {}, entry: string = BIN) {
  const home = mkdtempSync(join(tmpdir(), 'distill-cli-test-'));
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', entry, ...args],
    {
      encoding: 'utf8',
      // Pipes, not a TTY: this is the condition that exposed the bug.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
        ACTARIO_HOME: join(home, '.actario'),
        ACTARIO_DOWNLOADS: join(home, 'Downloads'),
        // Adapters scan the real home directory, so the box running the tests
        // would otherwise contribute its own sessions and make the
        // empty-machine cases depend on who is running them.
        HOME: home,
        USERPROFILE: home,
        ...env,
      },
    },
  );
}

describe('the CLI actually writes to stdout', () => {
  it('help prints usage and exits 0', () => {
    const r = runCli(['help']);
    expect(r.status).toBe(0);
    expect(r.stdout.length, 'stdout was empty: buffered output is being discarded').toBeGreaterThan(0);
    expect(r.stdout).toContain('actario capture');
  });

  it('version prints a version', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('doctor prints a diagnosis even when no source exists on this machine', () => {
    // The empty-machine case still has to say something: a silent doctor is
    // indistinguishable from a broken one.
    const r = runCli(['doctor']);
    expect(r.status).toBe(0);
    expect(r.stdout, 'doctor produced no output').toContain('Source diagnosis');
    expect(r.stdout).toContain('claude_code_session');
  });

  it('capture --dry-run prints a report and exits 2 on an empty machine', () => {
    // Nothing to capture is a rejection with a remediation list, and both the
    // report and the list have to survive the exit.
    const r = runCli(['capture', '--dry-run']);
    expect(r.stdout).toContain('Capture report');
    expect(r.stdout).toContain('What to do');
    expect(r.stdout).toContain('actario doctor');
    expect(r.status).toBe(2);
  });

  it('an unknown command explains itself on stderr and exits 1', () => {
    const r = runCli(['frobnicate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });

  it('--no-redact warns that credential rules stay on (C6)', () => {
    const r = runCli(['capture', '--dry-run', '--no-redact']);
    expect(r.stderr).toContain('--no-redact is set');
    expect(r.stderr).toContain('cannot be disabled');
  });
});

describe('both entry points work', () => {
  // The bug this guards: the npm scripts pointed at index.ts, which only
  // exported main(). Node imported it, called nothing, exited 0. Silent
  // success is the one outcome a CLI must never fake.
  it('the module can be executed directly, not just imported', () => {
    const r = runCli(['help'], {}, MODULE);
    expect(r.status).toBe(0);
    expect(r.stdout, 'index.ts produced no output when run directly').toContain('actario capture');
  });

  it('both entry points produce identical output', () => {
    const viaBin = runCli(['help'], {}, BIN);
    const viaModule = runCli(['help'], {}, MODULE);
    expect(viaModule.stdout).toBe(viaBin.stdout);
  });
});
