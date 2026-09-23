import { describe, expect, it } from 'vitest';
import type { UcfRun } from '@distill/ucf';
import { score } from './score.ts';
import { CQS_VERSION } from './cqs-weights.ts';

const run = (over: Partial<UcfRun> = {}): UcfRun => ({
  run_ref: 'r1',
  agent_ref: null,
  platform: 'claude_code',
  model: 'claude-sonnet-4-6',
  started_at: '2026-09-01T00:00:00.000Z',
  ended_at: '2026-09-01T01:00:00.000Z',
  outcome: 'completed',
  title: 't',
  binding_hints: [],
  turns: [{
    idx: 0, role: 'user', content: 'hi', timestamp: '2026-09-01T00:00:00.000Z',
    tool_calls: null, branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {},
  }],
  artifacts: [],
  parse_level: 'strict',
  adapter_id: 'a',
  adapter_version: '1',
  degraded_fields: [],
  absent_by_capability: [],
  raw_ext: {},
  ...over,
});

const base = { dropped: [], adapters: [], redactions: {}, profile: 'general' as const };

describe('CQS', () => {
  it('stamps the weights version onto every report', () => {
    expect(score({ ...base, runs: [run()] }).report.cqs_version).toBe(CQS_VERSION);
  });

  it('a clean strict capture scores 100', () => {
    expect(score({ ...base, runs: [run()] }).report.cqs).toBe(100);
  });

  it('does NOT charge for fields the source never had (6.2)', () => {
    // A plain chat export has no tool calls and no artifacts. Punishing that
    // gives chat-only users a permanently low score they cannot act on, and a
    // score you cannot act on gets ignored.
    const chat = run({
      absent_by_capability: ['tool_calls', 'artifacts'],
      degraded_fields: [],
    });
    const r = score({ ...base, runs: [chat] });
    expect(r.report.cqs).toBe(100);
    expect(r.verdict).toBe('ok');
    expect(r.report.absent_by_capability).toEqual(['artifacts', 'tool_calls']);
  });

  it('DOES charge when a source that should have tool calls yielded none', () => {
    const broken = run({ degraded_fields: ['tool_calls'], absent_by_capability: [] });
    const r = score({ ...base, runs: [broken] });
    expect(r.report.cqs).toBeLessThan(100);
    expect(r.report.degraded_fields).toContain('tool_calls');
    expect(r.remediation.join(' ')).toMatch(/actario doctor/);
  });

  it('scales a deduction by the share of runs affected', () => {
    const one = score({ ...base, runs: [run({ degraded_fields: ['tool_calls'] }), run()] });
    const both = score({
      ...base,
      runs: [run({ degraded_fields: ['tool_calls'] }), run({ degraded_fields: ['tool_calls'] })],
    });
    expect(both.report.cqs).toBeLessThan(one.report.cqs);
  });

  it('rejects a batch that dropped more than 30% of its runs', () => {
    const r = score({
      ...base,
      runs: [run()],
      dropped: [
        { run_ref: 'x', reason: 'required_field_missing' },
        { run_ref: 'y', reason: 'required_field_missing' },
      ],
    });
    expect(r.verdict).toBe('reject');
    expect(r.remediation.join(' ')).toMatch(/format changed/);
  });

  it('rejects an empty capture and says how to investigate it', () => {
    const r = score({ ...base, runs: [] });
    expect(r.verdict).toBe('reject');
    expect(r.remediation[0]).toMatch(/actario doctor/);
  });

  it('warns rather than fails when a source dropped out entirely (13.3)', () => {
    const r = score({
      ...base,
      runs: [run()],
      adapters: [
        { adapter_id: 'claude_code_session', adapter_version: '2026-08', runs: 1, ok: true },
        { adapter_id: 'chatgpt_export', adapter_version: '2026-01', runs: 0, ok: false, error: 'zip unreadable' },
      ],
    });
    expect(r.verdict).not.toBe('reject');
    expect(r.report.warnings.join(' ')).toMatch(/failed entirely/);
  });

  it('counts loose and raw runs and explains them without alarming language', () => {
    const r = score({
      ...base,
      runs: [run({ parse_level: 'loose' }), run({ parse_level: 'raw' })],
    });
    expect(r.report.parse_levels).toEqual({ strict: 0, loose: 1, raw: 1 });
    const text = r.report.warnings.join(' ');
    expect(text).toMatch(/partly recognised/);
    expect(text).not.toMatch(/error|fail/i);
  });

  it('penalises a window that is mostly silence', () => {
    const sparse = [
      run({ started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T01:00:00.000Z' }),
      run({ started_at: '2026-08-30T00:00:00.000Z', ended_at: '2026-08-30T01:00:00.000Z' }),
    ];
    const r = score({ ...base, runs: sparse });
    expect(r.report.coverage_gap_pct).toBeGreaterThan(80);
    expect(r.report.cqs).toBeLessThan(100);
  });
});

describe('substance counts (not just field presence)', () => {
  const withTools = (): UcfRun => run({
    turns: [{
      idx: 0, role: 'assistant', content: 'done', timestamp: '2026-09-01T00:00:00.000Z',
      tool_calls: [
        { name: 'Write', params: {}, raw_ext: {} },
        { name: 'Bash', params: {}, raw_ext: {} },
      ],
      branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {},
    }],
    artifacts: [{ path: 'a.ts', change: 'created', diff_summary: '+3 -0', diff_body: null, sha256: null, raw_ext: {} }],
  });

  it('reports totals and how many runs contributed', () => {
    const r = score({ ...base, runs: [withTools(), run()] });
    expect(r.report.tool_calls_total).toBe(2);
    expect(r.report.artifacts_total).toBe(1);
    expect(r.report.runs_with_tool_calls).toBe(1);
    expect(r.report.runs_with_artifacts).toBe(1);
  });

  it('a source that should have tool calls and produced none across the batch is called a format change', () => {
    // The distinction that matters: zero tool calls in 49 runs from a source
    // that has them is not a quiet week, and the advice must not suggest it
    // might be. One run of 49 is a different story entirely.
    const r = score({ ...base, runs: [run({ degraded_fields: ['tool_calls'] }), run({ degraded_fields: ['tool_calls'] })] });
    expect(r.report.runs_with_tool_calls).toBe(0);
    expect(r.remediation.join(' ')).toMatch(/format change rather than a quiet week/);
    expect(r.remediation.join(' ')).toMatch(/doctor --schema/);
  });

  it('says nothing of the sort when the source never had tool calls', () => {
    const r = score({ ...base, runs: [run({ absent_by_capability: ['tool_calls', 'artifacts'] })] });
    expect(r.remediation.join(' ')).not.toMatch(/format change/);
    expect(r.report.cqs).toBe(100);
  });
});
