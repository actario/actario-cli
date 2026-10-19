import type { CaptureReport } from '@distill/shared';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColour ? `[${code}m${s}[0m` : s);
export const bold = c('1');
export const dim = c('2');
export const green = c('32');
export const yellow = c('33');
export const red = c('31');

export const heading = (s: string): string => `\n${bold(s)}\n`;

/**
 * The capture report is the only thing most users will ever read from this
 * tool, so it says what happened, what it cost them, and what to do -- in that
 * order. Degradation is reported as a fact, not as an error (6.3).
 */
export function formatReport(r: CaptureReport, verdict: 'ok' | 'warn' | 'reject'): string {
  const lines: string[] = [];
  const badge = verdict === 'ok' ? green('OK') : verdict === 'warn' ? yellow('WARN') : red('REJECTED');

  lines.push(heading('Capture report'));
  lines.push(`  quality       ${r.cqs}/100  [${badge}]  ${dim(`(${r.cqs_version})`)}`);
  lines.push(`  runs          ${r.runs_kept} kept, ${r.runs_dropped} dropped of ${r.runs_total}`);
  lines.push(
    `  parse level   ${r.parse_levels.strict} strict, ${r.parse_levels.loose} partial, ${r.parse_levels.raw} text-only`,
  );
  if (r.coverage_start && r.coverage_end) {
    lines.push(`  covers        ${r.coverage_start.slice(0, 10)} to ${r.coverage_end.slice(0, 10)}  ${dim(`(${r.coverage_gap_pct}% of days idle)`)}`);
  }

  // The counts that turn "unreadable" into a number you can act on.
  if (r.runs_kept > 0) {
    const toolNote = r.absent_by_capability.includes('tool_calls')
      ? dim('(this source has none)')
      : r.runs_with_tool_calls === 0
        ? yellow('none found -- see `actario doctor --schema`')
        : dim(`in ${r.runs_with_tool_calls}/${r.runs_kept} run(s)`);
    lines.push(`  tool calls    ${String(r.tool_calls_total).padEnd(6)} ${toolNote}`);
    const artNote = r.absent_by_capability.includes('artifacts')
      // Covers both honest cases: a chat source that has no artifacts at all,
      // and a coding session where nothing was written because the edits went
      // through Bash rather than a Write call. Neither is worth acting on.
      ? dim('no file-changing tool was used')
      : r.runs_with_artifacts === 0
        ? yellow('none found')
        : dim(`in ${r.runs_with_artifacts}/${r.runs_kept} run(s)`);
    lines.push(`  file changes  ${String(r.artifacts_total).padEnd(6)} ${artNote}`);
  }

  if ((r.result_truncated_pct ?? 0) > 0) {
    // Informational only (open #9). Said plainly so nobody reads it as a defect.
    lines.push(`  tool output   ${r.result_truncated_pct}% capped at 8 KB ${dim('(by design; not scored)')}`);
  }

  const redactionTotal = Object.values(r.redactions).reduce((a, b) => a + b, 0);
  if (redactionTotal > 0) {
    const detail = Object.entries(r.redactions).map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push(`  redacted      ${redactionTotal} value(s)  ${dim(detail)}`);
  }

  if (r.absent_by_capability.length > 0) {
    lines.push(
      `  not available  ${r.absent_by_capability.join(', ')} ${dim('(this source never had these; no score penalty)')}`,
    );
  }
  if (r.degraded_fields.length > 0) {
    lines.push(`  ${yellow('unreadable')}     ${r.degraded_fields.join(', ')} ${dim('(expected here, but could not be parsed)')}`);
  }

  for (const a of r.adapters) {
    const state = a.ok ? green('ok') : red('failed');
    lines.push(`  source        ${a.adapter_id}@${a.adapter_version}  ${a.runs} run(s)  ${state}${a.error ? dim(` -- ${a.error}`) : ''}`);
  }

  if (r.warnings.length > 0) {
    lines.push(heading('Notes'));
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function formatRemediation(items: string[]): string {
  if (items.length === 0) return '';
  return [heading('What to do'), ...items.map((i, n) => `  ${n + 1}. ${i}`)].join('\n');
}
