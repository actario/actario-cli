import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRun } from '@distill/ucf';
import { CHAT_FORMAT, coworkLive } from './cowork-live.ts';

/**
 * The live-conversation channel.
 *
 * This is the one source with no log file behind it -- an assistant writes the
 * record about the conversation it is in. So the properties worth pinning are
 * about honesty rather than parsing: it must not claim capabilities it cannot
 * guarantee, it must not invent tool parameters, and it must decline files
 * that only look like its format.
 */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/cowork_live/happy/input.chat.json',
);
const text = readFileSync(FIXTURE, 'utf8');
const unit = {
  unitId: 'distill-m1a-week3',
  path: '/home/u/.distill/inbox/2026-09-03.chat.json',
  bytes: text.length,
  mtime: '2026-09-03T18:10:00.000Z',
  read: async () => text,
};
const parse = () => coworkLive.toUCF(unit, text).runs[0]!;

describe('recognising its own format', () => {
  it('accepts a versioned record', () => {
    expect(coworkLive.sniff(text)).toBe(true);
  });

  it('declines anything without the format marker, so it never claims another source', () => {
    expect(coworkLive.sniff(JSON.stringify({ turns: [{ role: 'user', content: 'x' }] }))).toBe(false);
    expect(coworkLive.sniff(JSON.stringify({ format: 'something/v1', turns: [] }))).toBe(false);
    expect(coworkLive.sniff('not json')).toBe(false);
  });

  it('carries the format version into raw_ext, so a later change is traceable', () => {
    expect(parse().raw_ext).toMatchObject({ chat_format: CHAT_FORMAT });
  });
});

describe('turns', () => {
  it('keeps every non-empty turn, in order, with roles normalised', () => {
    const run = parse();
    expect(run.turns!.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(run.turns![0]!.content).toContain('42501');
  });

  it('records tool names but never invents parameters', () => {
    // The record is written by an assistant describing what it did. A summary
    // is a claim it can support; argument values would be fabrication in the
    // source of truth.
    const tools = parse().turns![1]!.tool_calls!;
    expect(tools.map((t) => t.name)).toEqual(['device_bash', 'Edit']);
    expect(tools[0]!.params).toEqual({ summary: '確認 apps/web/.env.local 是否存在' });
    expect(tools[1]!.params).toBeUndefined();
  });

  it('accepts a bare tool name as a string', () => {
    expect(parse().turns![1]!.tool_calls!.some((t) => t.name === 'Edit')).toBe(true);
  });
});

describe('capabilities are declared honestly (6.2)', () => {
  it('claims nothing beyond roles and content, so a plain record is not penalised', () => {
    // Declaring hasToolCalls would make their absence a degradation, and cost
    // CQS points for something a narrative record cannot be expected to have.
    expect(coworkLive.capabilities).toEqual({
      hasTurnTimestamps: false,
      hasToolCalls: false,
      hasArtifacts: false,
      hasBranches: false,
      hasOutcome: false,
    });
  });

  it('reports no degraded fields at all', () => {
    expect(parse().degraded_fields).toEqual([]);
  });

  it('drops tool_calls from the absent list when the record did carry them', () => {
    const run = parse();
    expect(run.absent_by_capability).not.toContain('tool_calls');
    expect(run.absent_by_capability).toContain('artifacts');
  });
});

describe('binding, never guessing', () => {
  it('turns an explicit repo path or project into binding hints', () => {
    const hints = parse().binding_hints!;
    expect(hints.map((h) => h.type).sort()).toEqual(['conversation_id', 'project_hint', 'repo_path']);
  });

  it('declares an agent only because the record named one explicitly', () => {
    const result = coworkLive.toUCF(unit, text);
    expect(result.agents).toHaveLength(1);
    // conversation_id is per-conversation, so binding an agent to it would
    // create a new agent for every chat.
    expect(result.agents[0]!.bindings.map((b) => b.type)).not.toContain('conversation_id');
  });

  it('leaves the run unbound when nothing was named', () => {
    const bare = JSON.stringify({
      format: CHAT_FORMAT, platform: 'cowork',
      turns: [{ role: 'user', content: 'no project named' }],
    });
    const result = coworkLive.toUCF({ ...unit, read: async () => bare }, bare);
    expect(result.runs[0]!.agent_ref).toBeNull();
    expect(result.agents).toHaveLength(0);
  });
});

describe('output is valid UCF', () => {
  it('validates', () => {
    expect(validateRun(parse()).ok).toBe(true);
  });

  it('falls back to the file mtime when the record carried no times', () => {
    const bare = JSON.stringify({
      format: CHAT_FORMAT, turns: [{ role: 'user', content: 'x' }],
    });
    const run = coworkLive.toUCF({ ...unit, read: async () => bare }, bare).runs[0]!;
    expect(run.started_at).toBe('2026-09-03T18:10:00.000Z');
  });

  it('preserves keys the format does not define yet', () => {
    const extended = JSON.stringify({
      format: CHAT_FORMAT, some_future_field: { a: 1 },
      turns: [{ role: 'user', content: 'x', sentiment: 'calm' }],
    });
    const run = coworkLive.toUCF({ ...unit, read: async () => extended }, extended).runs[0]!;
    expect(run.raw_ext).toHaveProperty('some_future_field');
    expect(run.turns![0]!.raw_ext).toMatchObject({ sentiment: 'calm' });
  });
});

describe('the model field', () => {
  it('is absent by capability when the record omits it, not a failed read', () => {
    // Otherwise every record takes a permanent deduction for something a
    // narrative account cannot be expected to know.
    const run = parse();
    expect(run.model).toBeNull();
    expect(run.absent_by_capability).toContain('model');
    expect(run.degraded_fields).not.toContain('model');
  });

  it('is used when the record does name one', () => {
    const withModel = JSON.stringify({
      format: CHAT_FORMAT, model: 'claude-opus-5',
      turns: [{ role: 'user', content: 'x' }],
    });
    const run = coworkLive.toUCF({ ...unit, read: async () => withModel }, withModel).runs[0]!;
    expect(run.model).toBe('claude-opus-5');
    expect(run.absent_by_capability).not.toContain('model');
  });
});
