import type { CaptureReport } from '@distill/shared';
import type { UcfRun } from '@distill/ucf';
import {
  COVERAGE_GAP_WEIGHT, CQS_REJECT_BELOW, CQS_VERSION, CQS_WARN_BELOW,
  FIELD_WEIGHTS, MAX_DROPPED_FRACTION, TRUNCATION_WEIGHT,
} from './cqs-weights.ts';

export interface DroppedRun {
  run_ref: string;
  reason: string;
  parse_level?: string;
}

export interface ScoreInput {
  runs: UcfRun[];
  dropped: DroppedRun[];
  adapters: CaptureReport['adapters'];
  redactions: Record<string, number>;
  profile: 'medical' | 'general';
}

export type CqsVerdict = 'ok' | 'warn' | 'reject';

/**
 * Time coverage gap: the share of the captured window with no activity at all.
 * A month-long window holding two days of conversation is a thinner record
 * than the run count suggests, and the score should say so.
 */
function coverageGapPct(runs: UcfRun[]): number {
  const spans = runs
    .map((r) => [r.started_at, r.ended_at ?? r.started_at] as const)
    .filter((s): s is readonly [string, string] => s[0] != null && s[1] != null)
    .map(([a, b]) => [new Date(a).getTime(), new Date(b).getTime()] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (spans.length < 2) return 0;

  const windowStart = spans[0]![0];
  const windowEnd = Math.max(...spans.map((s) => s[1]));
  const total = windowEnd - windowStart;
  if (total <= 0) return 0;

  // Union of active days, so a gap means "no conversation that day".
  const DAY = 86_400_000;
  const activeDays = new Set<number>();
  for (const [a, b] of spans) {
    for (let d = Math.floor(a / DAY); d <= Math.floor(b / DAY); d++) activeDays.add(d);
  }
  const totalDays = Math.max(1, Math.ceil(total / DAY));
  return Math.min(100, Math.max(0, ((totalDays - activeDays.size) / totalDays) * 100));
}

/**
 * Only `truncated` counts here. `result_truncated` is deliberately excluded
 * (arch v1.2 0.7): capping a tool result is the format's decision, not data
 * loss, and folding it in would lower CQS for something the user cannot act
 * on -- the ADR 14 mistake in a new place.
 */
const truncationPct = (runs: UcfRun[]): number => {
  const turns = runs.flatMap((r) => r.turns);
  if (turns.length === 0) return 0;
  return (turns.filter((t) => t.truncated).length / turns.length) * 100;
};

/** Informational. Feeds open question #9, never the score. */
const resultTruncatedPct = (runs: UcfRun[]): number => {
  const withResult = runs.flatMap((r) => r.turns).filter((t) => t.tool_result != null);
  if (withResult.length === 0) return 0;
  return (withResult.filter((t) => t.result_truncated).length / withResult.length) * 100;
};

export interface ScoreResult {
  report: CaptureReport;
  verdict: CqsVerdict;
  /** Concrete, actionable lines. Printed on reject, per 6.1 step 6. */
  remediation: string[];
}

export function score(input: ScoreInput): ScoreResult {
  const { runs, dropped } = input;
  const kept = runs.length;
  const total = kept + dropped.length;

  const degradedShare = new Map<string, number>();
  const absentEverywhere = new Set<string>();
  if (kept > 0) {
    const counts = new Map<string, number>();
    for (const r of runs) {
      for (const f of r.degraded_fields) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    for (const [f, n] of counts) degradedShare.set(f, n / kept);
    // A field is "absent by capability" only if every run agrees it is.
    const candidates = new Set(runs.flatMap((r) => r.absent_by_capability));
    for (const f of candidates) {
      if (runs.every((r) => r.absent_by_capability.includes(f))) absentEverywhere.add(f);
    }
  }

  let cqs = 100;
  const deductions: { field: string; points: number }[] = [];
  for (const [field, share] of degradedShare) {
    // Never charge for something the source structurally does not have (6.2).
    if (absentEverywhere.has(field)) continue;
    const weight = FIELD_WEIGHTS[field] ?? 2;
    const points = weight * share;
    cqs -= points;
    deductions.push({ field, points });
  }

  const gap = coverageGapPct(runs);
  const trunc = truncationPct(runs);
  cqs -= gap * COVERAGE_GAP_WEIGHT;
  cqs -= trunc * TRUNCATION_WEIGHT;
  cqs = Math.max(0, Math.min(100, Math.round(cqs)));

  const droppedFraction = total > 0 ? dropped.length / total : 0;
  const unfitByDrops = droppedFraction > MAX_DROPPED_FRACTION;

  const levels = { strict: 0, loose: 0, raw: 0 };
  for (const r of runs) levels[r.parse_level]++;

  const times = runs
    .flatMap((r) => [r.started_at, r.ended_at])
    .filter((t): t is string => t != null)
    .sort();

  const warnings: string[] = [];
  if (levels.loose > 0) {
    warnings.push(
      `${levels.loose} session(s) were only partly recognised, so the summary quality will drop. Run \`actario doctor\` to report the format.`,
    );
  }
  if (levels.raw > 0) {
    warnings.push(
      `${levels.raw} file(s) were kept as plain-text archive only; they are searchable but do not feed state summaries.`,
    );
  }
  for (const a of input.adapters) {
    if (!a.ok) warnings.push(`Source ${a.adapter_id} failed entirely: ${a.error ?? 'unknown error'}. Other sources still uploaded.`);
  }
  if (dropped.length > 0) {
    warnings.push(`${dropped.length} run(s) were dropped and are listed in the report.`);
  }

  const toolCallsTotal = runs.reduce(
    (n, r) => n + r.turns.reduce((m, t) => m + (t.tool_calls?.length ?? 0), 0), 0);
  const artifactsTotal = runs.reduce((n, r) => n + r.artifacts.length, 0);
  const runsWithTools = runs.filter(
    (r) => r.turns.some((t) => (t.tool_calls?.length ?? 0) > 0)).length;
  const runsWithArtifacts = runs.filter((r) => r.artifacts.length > 0).length;

  const report: CaptureReport = {
    cqs,
    cqs_version: CQS_VERSION,
    runs_total: total,
    runs_kept: kept,
    runs_dropped: dropped.length,
    parse_levels: levels,
    coverage_start: times[0] ?? null,
    coverage_end: times[times.length - 1] ?? null,
    coverage_gap_pct: Number(gap.toFixed(1)),
    truncation_pct: Number(trunc.toFixed(1)),
    result_truncated_pct: Number(resultTruncatedPct(runs).toFixed(1)),
    tool_calls_total: toolCallsTotal,
    artifacts_total: artifactsTotal,
    runs_with_tool_calls: runsWithTools,
    runs_with_artifacts: runsWithArtifacts,
    degraded_fields: [...degradedShare.keys()].filter((f) => !absentEverywhere.has(f)).sort(),
    absent_by_capability: [...absentEverywhere].sort(),
    redactions: input.redactions,
    warnings,
    adapters: input.adapters,
  };

  const verdict: CqsVerdict =
    kept === 0 || unfitByDrops || cqs < CQS_REJECT_BELOW ? 'reject'
      : cqs < CQS_WARN_BELOW ? 'warn'
        : 'ok';

  return { report, verdict, remediation: remediate(report, deductions, unfitByDrops, kept) };
}

/**
 * A rejected capture must say what to do next. "Quality too low" with no list
 * teaches the user to ignore the number (6.6).
 */
function remediate(
  report: CaptureReport,
  deductions: { field: string; points: number }[],
  unfitByDrops: boolean,
  kept: number,
): string[] {
  const out: string[] = [];
  if (kept === 0) {
    out.push('Nothing could be captured. Check that the source paths exist: `actario doctor`.');
  }
  if (unfitByDrops) {
    out.push(
      `More than ${MAX_DROPPED_FRACTION * 100}% of runs were dropped for missing required fields. This usually means the source format changed: run \`actario doctor --dump-sample\` and attach the sample.`,
    );
  }
  if (kept > 0 && report.runs_with_tool_calls === 0
      && !report.absent_by_capability.includes('tool_calls')) {
    out.push(
      `No tool records were found in any of the ${kept} run(s), from a source that should have them. ` +
      'That is a format change rather than a quiet week: run `actario doctor --schema` to see where they moved to.',
    );
  }
  for (const d of [...deductions].sort((a, b) => b.points - a.points).slice(0, 4)) {
    out.push(FIELD_ADVICE[d.field] ?? `Field \`${d.field}\` was expected but unreadable in some runs (-${d.points.toFixed(1)}).`);
  }
  if (report.coverage_gap_pct > 40) {
    out.push(`${report.coverage_gap_pct}% of the captured window has no activity. Narrow the window with \`--since 14d\` if that is expected.`);
  }
  if (report.truncation_pct > 10) {
    out.push(`${report.truncation_pct}% of turns are truncated. Very long sessions get cut; consider capturing more often.`);
  }
  return out;
}

const FIELD_ADVICE: Record<string, string> = {
  tool_calls: 'Tool records could not be read from sessions that should have them. The session format has probably changed -- run `actario doctor`.',
  artifacts: 'File-changing tool calls were found but the changed paths could not be read. That points at a format change -- run `actario doctor --schema`.',
  turn_timestamps: 'Turn timestamps are missing, so activity ordering is approximate.',
  role: 'Speaker roles could not be identified, so these files were archived as plain text only.',
  malformed_lines: 'Some session lines were unreadable JSON and were skipped. `actario doctor --dump-sample` produces a de-identified sample to report.',
};

export { CQS_VERSION, CQS_REJECT_BELOW, CQS_WARN_BELOW };
