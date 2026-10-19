import { zUcfRun, type UcfRun, type UcfRunDraft } from './schema.ts';

export interface ValidationOk {
  ok: true;
  run: UcfRun;
  /** Expected fields that came back empty. Reported, never fatal (C5). */
  degraded: string[];
}

export interface ValidationFailure {
  ok: false;
  /** Only a missing *required* field lands here: the run is dropped and listed. */
  reason: string;
  issues: { path: string; message: string }[];
}

export type ValidationResult = ValidationOk | ValidationFailure;

const EXPECTED_FIELDS = ['started_at', 'model', 'outcome', 'title'] as const;

/**
 * One run in, one verdict out. The isolation unit is the run -- not the file
 * and definitely not the batch (6.3 rule 2), so a caller loops over runs and
 * keeps going after a failure.
 */
export function validateRun(draft: UcfRunDraft): ValidationResult {
  const parsed = zUcfRun.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'required_field_missing',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  const run = parsed.data;
  const degraded = new Set(run.degraded_fields);
  const absent = new Set(run.absent_by_capability);

  for (const f of EXPECTED_FIELDS) {
    if (run[f] == null && !absent.has(f)) degraded.add(f);
  }
  const noToolCalls = run.turns.every((t) => t.tool_calls == null);
  if (noToolCalls && !absent.has('tool_calls')) degraded.add('tool_calls');
  if (run.artifacts.length === 0 && !absent.has('artifacts')) degraded.add('artifacts');
  if (run.turns.some((t) => t.timestamp == null) && !absent.has('turn_timestamps')) {
    degraded.add('turn_timestamps');
  }

  return {
    ok: true,
    run: { ...run, degraded_fields: [...degraded].sort() },
    degraded: [...degraded].sort(),
  };
}

/** NDJSON line -> run. Used by the worker's streaming parser (7.1). */
export function parseRunLine(line: string): ValidationResult {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (e) {
    return {
      ok: false,
      reason: 'malformed_json_line',
      issues: [{ path: '', message: (e as Error).message }],
    };
  }
  return validateRun(json as UcfRunDraft);
}

export const zUcfRunLine = zUcfRun;
