import { mkdtempSync, mkdirSync, copyFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from '@distill/adapters';
import { runCapture } from './pipeline.ts';
import { zState } from './config.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../adapters/__fixtures__/claude_code_session/happy/input.jsonl');

/**
 * Two clocks. collect() skips units whose FILE mtime is before the high-water
 * mark, so the mark must be committed from file mtimes. The first real
 * machine committed the report's coverage_end (a CONTENT timestamp) instead,
 * and 11 of 49 sessions -- files last written before the newest message of
 * the batch -- disappeared from every later capture without a trace.
 */
describe('the high-water mark is a file clock', () => {
  function home(): { home: string; projects: string } {
    const h = mkdtempSync(join(tmpdir(), 'distill-hw-'));
    const projects = join(h, '.claude', 'projects', '-tmp-x');
    mkdirSync(projects, { recursive: true });
    return { home: h, projects };
  }

  async function capture(h: string, lastSeenAt: string | null) {
    const state = zState.parse({ sources: lastSeenAt
      ? { 'claude_code_session@2026-08': { last_seen_at: lastSeenAt, uploaded_hashes: [], last_upload_id: null } }
      : {} });
    return runCapture({
      env: { homedir: h, platform: process.platform, extraPaths: [], downloadsDir: join(h, 'Downloads') },
      adapters: BUILTIN_ADAPTERS,
      state,
      outDir: join(h, 'out'),
      cliVersion: 'test',
      profile: 'general',
      salt: 'salt',
      sources: ['claude_code_session'],
      noPack: true,
    });
  }

  it('reports the newest unit mtime per adapter, not the content coverage end', async () => {
    const { home: h, projects } = home();
    const oldFile = join(projects, 'old.jsonl');
    copyFileSync(FIXTURE, oldFile);
    // File written in June; its messages (the fixture) are from 2026-08.
    utimesSync(oldFile, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    const out = await capture(h, null);
    expect(out.runs).toHaveLength(1);
    const mark = out.maxMtimeByAdapter['claude_code_session@2026-08'];
    expect(mark).toBe(new Date('2026-06-01T00:00:00Z').toISOString());
    expect(mark).not.toBe(out.report.coverage_end);
  });

  it('a file older than a content-clock mark would be skipped -- the exact failure being prevented', async () => {
    const { home: h, projects } = home();
    const f = join(projects, 'old.jsonl');
    copyFileSync(FIXTURE, f);
    utimesSync(f, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    // Content clock as the mark (the old behaviour): the June file vanishes.
    const wrong = await capture(h, '2026-08-15T00:00:00Z');
    expect(wrong.runs).toHaveLength(0);

    // File clock as the mark (the fix): a file at exactly the mark is re-read
    // (dedupe is cheap; a lost session is not), and nothing older exists.
    const right = await capture(h, new Date('2026-06-01T00:00:00Z').toISOString());
    expect(right.runs).toHaveLength(1);
  });
});

/**
 * The state every scheduled capture reaches on a quiet day: the machine has
 * sessions, all of them are already uploaded, so the batch is empty. That is
 * routine, and the CLI has to be able to tell it apart from an empty batch
 * because nothing could be read at all -- only the first one has duplicates
 * to prove it, and only the second is worth waking someone for (R17).
 */
describe('nothing new to capture', () => {
  it('a machine whose sessions are all uploaded yields no runs, counted duplicates, and a healthy source', async () => {
    const h = mkdtempSync(join(tmpdir(), 'distill-dup-'));
    const projects = join(h, '.claude', 'projects', '-tmp-x');
    mkdirSync(projects, { recursive: true });
    copyFileSync(FIXTURE, join(projects, 'a.jsonl'));

    const state = zState.parse({});
    const first = await runCapture({
      env: { homedir: h, platform: process.platform, extraPaths: [], downloadsDir: join(h, 'Downloads') },
      adapters: BUILTIN_ADAPTERS, state, outDir: join(h, 'out'), cliVersion: 'test',
      profile: 'general', salt: 'salt', sources: ['claude_code_session'], noPack: true,
    });
    expect(first.runs).toHaveLength(1);
    const hashes = first.hashesByAdapter['claude_code_session@2026-08']!;
    expect(hashes).toHaveLength(1);

    const again = await runCapture({
      env: { homedir: h, platform: process.platform, extraPaths: [], downloadsDir: join(h, 'Downloads') },
      adapters: BUILTIN_ADAPTERS,
      state: zState.parse({ sources: { 'claude_code_session@2026-08': { last_seen_at: null, uploaded_hashes: hashes, last_upload_id: null } } }),
      outDir: join(h, 'out2'), cliVersion: 'test', profile: 'general', salt: 'salt',
      sources: ['claude_code_session'], noPack: true,
    });

    expect(again.runs).toHaveLength(0);
    expect(again.skippedDuplicates).toBe(1);
    expect(again.report.runs_total).toBe(0);
    // The three fields the CLI reads to call this "up to date" rather than a
    // rejected capture: no runs, some duplicates, and every source healthy.
    expect(again.report.adapters.every((a) => a.ok)).toBe(true);
    // The score still rejects -- it is a quality verdict over zero runs, and
    // that is precisely why the CLI has to decide this one for itself.
    expect(again.verdict).toBe('reject');
  });
});
