import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_PARAM_MAX_CHARS, TOOL_RESULT_MAX_BYTES, validateRun } from '@distill/ucf';
import { chatgptExport } from './chatgpt-export.ts';
import { claudeCodeSession2026_08 } from './claude-code.ts';
import { fileUnit } from './util.ts';
import type { CaptureAdapter } from './types.ts';

/**
 * Golden file contract tests (6.4).
 *
 * The reason these exist is failure localisation: when a platform changes its
 * format, CI must go red *here* and nowhere else. A red test in the analysis
 * layer would send the next person looking in the wrong place (P4).
 *
 * Regenerate deliberately with UPDATE_GOLDEN=1. Never edit an existing
 * expected file to make a new adapter version pass -- add a version instead
 * (6.3 rule 3).
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__');
const unitFor = (name: string) => ({
  unitId: name, path: `/tmp/${name}`, bytes: 0, mtime: null, read: async () => '',
});
const UPDATE = process.env.UPDATE_GOLDEN === '1';

async function goldenCase(adapter: CaptureAdapter, dir: string, inputName: string) {
  const caseDir = join(FIXTURES, dir);
  const inputPath = join(caseDir, inputName);
  const expectedPath = join(caseDir, 'expected.ucf.json');
  const unit = await fileUnit(inputPath);
  const text = readFileSync(inputPath, 'utf8');

  expect(adapter.sniff(text), 'adapter should recognise its own fixture').toBe(true);
  const result = adapter.toUCF(unit, text);

  // Paths and mtimes differ per machine; the contract is the parsed content.
  const normalised = {
    agents: result.agents,
    runs: result.runs.map((r) => ({ ...r, run_ref: r.run_ref.replace(/\\/g, '/').split('/').pop() })),
  };

  if (UPDATE || !existsSync(expectedPath)) {
    writeFileSync(expectedPath, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8');
  }
  expect(normalised).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')));
  return result;
}

describe('claude_code_session@2026-08', () => {
  it('matches its golden file', async () => {
    await goldenCase(claudeCodeSession2026_08, 'claude_code_session/happy', 'input.jsonl');
  });

  it('extracts tool calls and artifacts -- the reason this source matters', async () => {
    const r = await goldenCase(claudeCodeSession2026_08, 'claude_code_session/happy', 'input.jsonl');
    const run = r.runs[0]!;
    const toolNames = run.turns!.flatMap((t) => t.tool_calls?.map((c) => c.name) ?? []);
    expect(toolNames).toContain('Write');
    expect(run.artifacts!.map((a) => a.path.split('/').pop())).toEqual(
      expect.arrayContaining(['clean_v3.py', 'schema_notes.md']),
    );
    // v1.2: the statistics line is still there, and the body now travels
    // beside it (plan 5.6.1). Redaction runs over it later in the pipeline.
    expect(run.artifacts![0]!.diff_summary).toMatch(/^\+\d+ -\d+$/);
    expect(run.artifacts![0]!.diff_body).toContain('import pandas');
  });

  it('binds via repo path and session id, and never guesses an agent', async () => {
    const r = await goldenCase(claudeCodeSession2026_08, 'claude_code_session/happy', 'input.jsonl');
    const hints = r.runs[0]!.binding_hints!;
    expect(hints.find((h) => h.type === 'repo_path')?.value).toContain('clean-pipeline');
    expect(hints.some((h) => h.type === 'conversation_id')).toBe(true);
  });

  it('produces runs that validate against UCF v0.2', async () => {
    const r = await goldenCase(claudeCodeSession2026_08, 'claude_code_session/happy', 'input.jsonl');
    for (const draft of r.runs) expect(validateRun(draft).ok).toBe(true);
  });
});

describe('chatgpt_export', () => {
  it('matches its golden file', async () => {
    await goldenCase(chatgptExport, 'chatgpt_export/happy', 'input.json');
  });

  it('keeps regenerated branches instead of dropping them', async () => {
    const r = await goldenCase(chatgptExport, 'chatgpt_export/happy', 'input.json');
    const run = r.runs[0]!;
    const branched = run.turns!.filter((t) => t.branch_id != null);
    expect(branched.length).toBeGreaterThan(0);
    expect(run.turns!.some((t) => t.content.includes('Regenerated answer'))).toBe(true);
  });

  it('declares tool_calls and artifacts absent, so CQS does not punish chat users (6.2)', async () => {
    const r = await goldenCase(chatgptExport, 'chatgpt_export/happy', 'input.json');
    expect(r.runs[0]!.absent_by_capability).toEqual(
      expect.arrayContaining(['tool_calls', 'artifacts']),
    );
    expect(r.runs[0]!.degraded_fields).not.toContain('tool_calls');
  });

  it('preserves fields the exporter added that we do not know about (6.3 rule 1)', async () => {
    const r = await goldenCase(chatgptExport, 'chatgpt_export/happy', 'input.json');
    expect(r.runs[0]!.raw_ext).toHaveProperty('some_new_field_openai_added');
  });
});

describe('adapter interface', () => {
  it('every adapter declares its capabilities explicitly', () => {
    for (const a of [claudeCodeSession2026_08, chatgptExport]) {
      expect(Object.keys(a.capabilities).sort()).toEqual([
        'hasArtifacts', 'hasBranches', 'hasOutcome', 'hasToolCalls', 'hasTurnTimestamps',
      ]);
    }
  });

  it('sniff rejects a foreign format rather than throwing', () => {
    for (const a of [claudeCodeSession2026_08, chatgptExport]) {
      expect(a.sniff('not json at all')).toBe(false);
      expect(a.sniff('{"totally": "different"}')).toBe(false);
    }
  });
});

describe('the upload scope, v1.2 (plan 5.6.1; arch 0.7)', () => {
  const happy = () => goldenCase(claudeCodeSession2026_08, 'claude_code_session/happy', 'input.jsonl');

  it('carries tool params whole -- the v1.1 elision is gone on purpose', async () => {
    const r = await happy();
    const write = r.runs[0]!.turns!.flatMap((t) => t.tool_calls ?? []).find((c) => c.name === 'Write');
    expect(write!.params).toMatchObject({
      file_path: expect.stringContaining('clean_v3.py'),
      content: expect.stringContaining('import numpy as np'),
    });
  });

  it('caps a single param value instead of shipping a blob', () => {
    const big = 'x'.repeat(TOOL_PARAM_MAX_CHARS + 500);
    const line = JSON.stringify({
      type: 'assistant', uuid: 'u1', timestamp: '2026-09-01T00:00:00Z', sessionId: 's',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a', content: big } }] },
    });
    const r = claudeCodeSession2026_08.toUCF(unitFor('x.jsonl'), line);
    const write = r.runs[0]!.turns![0]!.tool_calls![0]!;
    const content = write.params!.content as string;
    expect(content.length).toBeLessThan(big.length);
    expect(content.endsWith('...[truncated by capture]')).toBe(true);
  });

  it('puts tool output in tool_result, not in content', async () => {
    const r = await happy();
    const withResult = r.runs[0]!.turns!.find((t) => t.tool_result != null);
    expect(withResult).toBeDefined();
    expect(withResult!.content).not.toContain(withResult!.tool_result!.slice(0, 20));
    expect(withResult!.result_truncated).toBe(false);
  });

  it('caps tool_result at the byte budget and flags it separately from `truncated`', () => {
    // Multi-byte text: the cut must land on a code point, never inside one.
    const big = '結果'.repeat(TOOL_RESULT_MAX_BYTES);
    const line = JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: '2026-09-01T00:00:00Z', sessionId: 's',
      message: { role: 'user', content: [{ type: 'tool_result', content: big }] },
    });
    const turn = claudeCodeSession2026_08.toUCF(unitFor('x.jsonl'), line).runs[0]!.turns![0]!;
    expect(Buffer.byteLength(turn.tool_result!, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(turn.tool_result!.includes('\uFFFD')).toBe(false);
    expect(turn.result_truncated).toBe(true);
    // The design decision is not data loss: the turn itself is not truncated.
    expect(turn.truncated).toBe(false);
  });

  it('honours upload_diffs=false by dropping the body and keeping the statistics', () => {
    const text = readFileSync(join(FIXTURES, 'claude_code_session/happy/input.jsonl'), 'utf8');
    const r = claudeCodeSession2026_08.toUCF(unitFor('input.jsonl'), text, { uploadDiffs: false });
    for (const a of r.runs[0]!.artifacts!) {
      expect(a.diff_body).toBeNull();
      expect(a.diff_summary).toMatch(/^\+\d+ -\d+$/);
    }
  });
});

describe('sniffing does not depend on line 1 (real-machine regression)', () => {
  it('recognises a session whose first records are metadata, not messages', async () => {
    // Found on a real install: 7 of 49 sessions opened with a `summary` or
    // `file-history-snapshot` record. Judging the format from the first line
    // alone dropped those whole files to the loose parser, which then reported
    // their tool records as unreadable and pulled CQS down for no reason.
    const dir = 'claude_code_session/summary_first';
    const inputPath = join(FIXTURES, dir, 'input.jsonl');
    const text = readFileSync(inputPath, 'utf8');
    expect(claudeCodeSession2026_08.sniff(text)).toBe(true);
  });

  it('still parses that file strictly, tool calls and all', async () => {
    const r = await goldenCase(claudeCodeSession2026_08, 'claude_code_session/summary_first', 'input.jsonl');
    const run = r.runs[0]!;
    expect(run.parse_level).toBe('strict');
    expect(run.turns!.flatMap((t) => t.tool_calls ?? []).map((c) => c.name)).toContain('Edit');
    expect(run.artifacts!.map((a) => a.path.split('/').pop())).toContain('ingest.ts');
    expect(run.degraded_fields).not.toContain('tool_calls');
  });

  it('still rejects a file that has no message records anywhere near the top', () => {
    const notSessions = [
      '{"type":"summary","summary":"only summaries"}\n{"type":"summary","summary":"still"}\n',
      'plain text log\nanother line\n',
      '{"unrelated":"json"}\n',
    ];
    for (const t of notSessions) expect(claudeCodeSession2026_08.sniff(t)).toBe(false);
  });

  it('keeps the new 2026-09 attribution keys instead of reporting them as noise', async () => {
    // agentId / attributionAgent / sourceToolAssistantUUID are subagent
    // attribution: resolve-agent will want them in week 4, so they are
    // recognised rather than left to rattle around in doctor output.
    const r = await goldenCase(claudeCodeSession2026_08, 'claude_code_session/summary_first', 'input.jsonl');
    const unknown = (r.runs[0]!.raw_ext as { unknown_record_keys?: string[] }).unknown_record_keys ?? [];
    for (const k of ['agentId', 'promptId', 'entrypoint']) expect(unknown).not.toContain(k);
  });
});

describe('artifacts: absent, unreadable, or genuinely nothing written', () => {
  const session = (blocks: unknown[]) => JSON.stringify({
    type: 'assistant', uuid: 'a1', sessionId: 's1', cwd: '/repo',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'assistant', content: blocks },
  });

  const parse = (text: string) =>
    claudeCodeSession2026_08.toUCF(
      { unitId: 'u', path: '/tmp/s.jsonl', bytes: text.length, mtime: null, read: async () => text },
      text,
    ).runs[0]!;

  it('tool calls but no write tool: artifacts are absent, not unreadable', () => {
    // The common real case. A session that edits files through Bash, sed or a
    // script makes no Write/Edit call, so there is nothing to record -- and
    // calling that a format change is a confident, wrong accusation.
    const run = parse(session([
      { type: 'text', text: 'running it' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pytest -q' } },
    ]));
    expect(run.degraded_fields).not.toContain('artifacts');
    expect(run.absent_by_capability).toContain('artifacts');
    expect(run.degraded_fields).not.toContain('tool_calls');
  });

  it('a write tool with no readable path: unreadable, and says so', () => {
    const run = parse(session([
      { type: 'tool_use', id: 't1', name: 'Write', input: { destination: '/repo/x.ts', body: 'x' } },
    ]));
    expect(run.degraded_fields).toContain('artifacts');
  });

  it('no tool blocks at all: the loud format-change signal', () => {
    const run = parse(session([{ type: 'text', text: 'just talking' }]));
    expect(run.degraded_fields).toContain('tool_calls');
  });
});

describe('outcome comes from evidence, not from a guess', () => {
  const rec = (over: Record<string, unknown> = {}) => JSON.stringify({
    type: 'assistant', uuid: 'a1', sessionId: 's1', cwd: '/repo',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ...over,
  });

  const parse = (text: string) =>
    claudeCodeSession2026_08.toUCF(
      { unitId: 'u', path: '/tmp/s.jsonl', bytes: text.length, mtime: null, read: async () => text },
      text,
    ).runs[0]!;

  it('an API error means failed, whatever the last message looks like', () => {
    // The case the old heuristic got exactly backwards: a run that died on a
    // 529 ends with an assistant message and was reported as "completed".
    expect(parse(rec({ isApiErrorMessage: true })).outcome).toBe('failed');
    expect(parse(rec({ apiErrorStatus: 529 })).outcome).toBe('failed');
  });

  it('reads stopReason when the format provides it', () => {
    expect(parse(rec({ stopReason: 'end_turn' })).outcome).toBe('completed');
    expect(parse(rec({ stopReason: 'max_tokens' })).outcome).toBe('interrupted');
    // Stopped waiting on a tool and never came back.
    expect(parse(rec({ stopReason: 'tool_use' })).outcome).toBe('ongoing');
  });

  it('falls back to the last speaker, and marks outcome degraded when it had to', () => {
    const run = parse(rec());
    expect(run.outcome).toBe('completed');
    // Honest about the guess: the share of runs needing the fallback is what
    // tells you whether this is an old archive or a format change (6.2).
    expect(run.degraded_fields).toContain('outcome');
  });

  it('collects attribution where resolve-agent will look for it (week 4)', () => {
    const run = parse(rec({ agentId: 'main', attributionSkill: 'distill-capture' }));
    expect(run.raw_ext).toMatchObject({
      attribution: { agentId: ['main'], attributionSkill: ['distill-capture'] },
    });
  });
});
