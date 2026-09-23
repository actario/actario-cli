import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ADAPTERS, fileUnit, type RawUnit } from '@distill/adapters';
import { validateRun } from '@distill/ucf';
import { parseLoose, parseRaw, parseStrict, sniffUnit } from './parse/index.ts';

/**
 * C5 acceptance suite.
 *
 * The M1a criterion is blunt: five deliberately broken session files, all five
 * must produce data, none may fail completely (arch 16). This file is that
 * criterion in executable form -- it is the gate, not an illustration.
 */
const BROKEN = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/broken');

/** Mirrors the adapt stage of the pipeline, for one unit. */
function adaptUnit(unit: RawUnit, text: string) {
  const sniffed = sniffUnit(text, BUILTIN_ADAPTERS);
  if (sniffed.level === 'strict' && sniffed.adapter) {
    const strict = parseStrict(sniffed.adapter, unit, text);
    if (strict.ok && strict.result && strict.result.runs.length > 0) {
      return { level: 'strict' as const, drafts: strict.result.runs };
    }
  }
  const loose = parseLoose(unit, text);
  if (loose.length > 0) return { level: 'loose' as const, drafts: loose };
  return { level: 'raw' as const, drafts: parseRaw(unit, text) };
}

const files = readdirSync(BROKEN).filter((f) => !f.endsWith('.md'));

describe('three-tier parsing never returns an empty batch (C5)', () => {
  it('has all five fixtures', () => {
    expect(files).toHaveLength(5);
  });

  for (const file of files) {
    it(`${file}: produces at least one valid run`, async () => {
      const path = join(BROKEN, file);
      const unit = await fileUnit(path);
      const text = readFileSync(path, 'utf8');

      const { drafts } = adaptUnit(unit, text);
      expect(drafts.length, `${file} produced nothing`).toBeGreaterThan(0);

      const valid = drafts.map(validateRun).filter((v) => v.ok);
      expect(valid.length, `${file} produced no schema-valid run`).toBeGreaterThan(0);
    });
  }
});

describe('each fixture lands on the level it should', () => {
  const expectations: Record<string, 'strict' | 'loose' | 'raw'> = {
    '01-renamed-keys.jsonl': 'loose',
    '02-renested.json': 'loose',
    '03-truncated.jsonl': 'strict',
    '04-unknown-fields.jsonl': 'strict',
    '05-alien-format.txt': 'raw',
  };

  for (const [file, level] of Object.entries(expectations)) {
    it(`${file} -> ${level}`, async () => {
      const path = join(BROKEN, file);
      const unit = await fileUnit(path);
      const text = readFileSync(path, 'utf8');
      expect(adaptUnit(unit, text).level).toBe(level);
    });
  }
});

describe('what each level costs the user', () => {
  const load = async (file: string) => {
    const path = join(BROKEN, file);
    const unit = await fileUnit(path);
    return adaptUnit(unit, readFileSync(path, 'utf8'));
  };

  it('renamed keys: turns survive with roles mapped, tool records are marked lost', async () => {
    const { drafts } = await load('01-renamed-keys.jsonl');
    const run = drafts[0]!;
    expect(run.turns!.length).toBe(3);
    expect(run.turns!.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(run.parse_level).toBe('loose');
    // "unreadable", not "absent": this is the distinction CQS depends on (6.2).
    expect(run.degraded_fields).toContain('tool_calls');
  });

  it('renamed keys: unrecognised keys are preserved, not dropped (6.3 rule 1)', async () => {
    const { drafts } = await load('01-renamed-keys.jsonl');
    const raw = JSON.stringify(drafts[0]!.turns);
    expect(raw).toContain('trace');
    expect(raw).toContain('cost_usd');
  });

  it('re-nesting three levels deeper still finds the messages', async () => {
    const { drafts } = await load('02-renested.json');
    const contents = drafts[0]!.turns!.map((t) => t.content);
    expect(contents.some((c) => c.includes('v2 fallback'))).toBe(true);
    expect(contents.some((c) => c.includes('Korea batch'))).toBe(true);
  });

  it('a truncated file keeps every complete line and loses only the partial one', async () => {
    const { drafts } = await load('03-truncated.jsonl');
    expect(drafts[0]!.turns!.length).toBe(2);
    expect(drafts[0]!.raw_ext).toMatchObject({ malformed_lines: 1 });
    expect(drafts[0]!.degraded_fields).toContain('malformed_lines');
  });

  it('unknown fields on a known shape: parsed strictly, extra keys kept', async () => {
    const { drafts, level } = await load('04-unknown-fields.jsonl');
    expect(level).toBe('strict');
    const run = drafts[0]!;
    expect(run.artifacts!.length).toBe(1);
    const rawText = JSON.stringify(run);
    expect(rawText).toContain('workspaceTrustLevel');
    expect(rawText).toContain('agentTelemetry');
    expect(run.raw_ext).toHaveProperty('unknown_record_keys');
  });

  it('an alien format is archived as searchable text, not discarded', async () => {
    const { drafts } = await load('05-alien-format.txt');
    const run = drafts[0]!;
    expect(run.parse_level).toBe('raw');
    expect(run.turns![0]!.role).toBe('unknown');
    expect(run.turns![0]!.content).toContain('reindex the embeddings');
    // Level raw is searchable and archived, and deliberately does not claim
    // to know who said what -- so it must not feed state summaries.
    expect(run.degraded_fields).toContain('role');
  });
});
