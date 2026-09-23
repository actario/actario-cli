import type { DafAnalyzer } from './schema.ts';

/**
 * The validation report (arch v1.3 §18.5) -- written to
 * `uploads.daf_validation_report`, shown on the Uploads page, and returned to
 * the CLI. It is two things at once: the user's "N entries were dropped
 * because their anchors did not resolve" line, and the rubric author's
 * feedback signal -- a rising drop rate means the anchoring guidance is
 * drifting, not that the user did something wrong.
 */

/** Why one item did not land. Each maps to one row of the §18.5 table. */
export type DropReason =
  /** rule 3 -- the run_hash matched no run of this upload (or this workspace) */
  | 'run_unresolved'
  /** rule 3 -- one or more source_turn_idx is not a turn of that run */
  | 'anchor_unresolved'
  /** rule 3, segments -- start or end idx is not a turn of that run */
  | 'range_unresolved'
  /** agent_states -- none of the source runs is bound to an agent */
  | 'agent_unresolved'
  /** agent_states -- the source runs belong to more than one agent */
  | 'agent_ambiguous'
  /** rule 5 -- past the per-run or total cap; counted, dropped */
  | 'over_cap'
  /** rule 6 -- `type` outside the closed set, or `confidence` outside [0, 1];
   *  for a page, text the database refused to store (design 0002) */
  | 'invalid_field';

export interface DroppedItem {
  kind: 'segment' | 'entry' | 'agent_state' | 'page';
  /** Position in the DAF array, so the author can find it. */
  index: number;
  /** The coordinate the item named (v0.2: runs.content_hash), null when the item named none. */
  run_hash: string | null;
  reason: DropReason;
  /** The offending indices, for anchor_unresolved / range_unresolved. */
  detail?: number[];
}

export interface PageOutcome {
  run_hash: string;
  run_id: string;
  version: number;
  current: boolean;
}

export interface KindCounts {
  received: number;
  written: number;
  dropped: number;
}

/**
 * Fields the server assigns whatever the DAF said (§18.5). Listed in the
 * report so the client can see the rule rather than infer it -- and so a
 * DAF that tried to set `status: confirmed` gets a visible answer.
 */
export const SERVER_OVERRIDDEN_FIELDS = [
  'status',            // always 'pending' (C8); never 'confirmed'
  'visibility',        // server default
  'workspace_id',      // from the PAT
  'author_user_id',    // from the PAT
  'analysis_origin',   // always 'client'
  'id',                // every id is server-generated
] as const;

export interface DafValidationReport {
  daf_version: '0.1';
  validated_at: string;
  analysis_run_id: string | null;
  /** Storage path of the DAF this verdict is about, so a client can match a verdict to its submission. */
  daf_ref: string | null;
  analyzer: DafAnalyzer;
  /** rejected = nothing from this DAF landed (rule 1 / rule 2); accepted = some or all did */
  outcome: 'accepted' | 'rejected';
  rejected_reason?: 'schema' | 'bundle_mismatch' | 'unreadable';
  schema_issues?: { path: string; message: string }[];
  counts: {
    segments: KindCounts;
    entries: KindCounts;
    agent_states: KindCounts;
    /** Note pages (2026-10-04). Absent on reports written before pages existed. */
    pages?: KindCounts;
  };
  /**
   * Where each written page landed. `current: false` means the page had been
   * edited on the web, so this analysis was kept as a draft version instead of
   * replacing the person's text. Absent on older reports.
   */
  pages?: PageOutcome[];
  dropped: DroppedItem[];
  /** How many dropped items did not fit in `dropped` (capped at DAF_LIMITS.reportDroppedMax). */
  dropped_truncated: number;
  /** run_hashes that were not in this upload but matched an earlier upload of the same workspace (dedupe case, §7.3). */
  runs_resolved_via_workspace: string[];
  /** Pending client-origin entries from an earlier DAF on the same runs that this one replaced (a re-run, §18.7). */
  replaced_pending: number;
  overridden: readonly string[];
}

/** Zero report for a DAF that never made it past the schema or the bundle check. */
export function rejectedReport(
  analyzer: DafAnalyzer,
  reason: NonNullable<DafValidationReport['rejected_reason']>,
  issues?: { path: string; message: string }[],
  dafRef: string | null = null,
): DafValidationReport {
  const zero = { received: 0, written: 0, dropped: 0 };
  return {
    daf_version: '0.1',
    validated_at: new Date().toISOString(),
    analysis_run_id: null,
    daf_ref: dafRef,
    analyzer,
    outcome: 'rejected',
    rejected_reason: reason,
    ...(issues ? { schema_issues: issues } : {}),
    counts: { segments: { ...zero }, entries: { ...zero }, agent_states: { ...zero }, pages: { ...zero } },
    dropped: [],
    dropped_truncated: 0,
    runs_resolved_via_workspace: [],
    replaced_pending: 0,
    overridden: SERVER_OVERRIDDEN_FIELDS,
  };
}

/** One line for humans: the CLI prints it, the Uploads page shows it. */
export function summarizeReport(r: DafValidationReport): string {
  if (r.outcome === 'rejected') {
    const why = r.rejected_reason === 'schema' ? 'did not match the DAF schema'
      : r.rejected_reason === 'bundle_mismatch' ? 'names a different bundle than this upload'
        : 'could not be read';
    return `analysis rejected: the DAF ${why}`;
  }
  const c = r.counts;
  const parts = [
    `${c.entries.written} entr${c.entries.written === 1 ? 'y' : 'ies'}`,
    `${c.segments.written} segment${c.segments.written === 1 ? '' : 's'}`,
    `${c.agent_states.written} state card${c.agent_states.written === 1 ? '' : 's'}`,
  ];
  if (c.pages && c.pages.received > 0) parts.push(`${c.pages.written} note page${c.pages.written === 1 ? '' : 's'}`);
  const dropped = c.entries.dropped + c.segments.dropped + c.agent_states.dropped + (c.pages?.dropped ?? 0);
  const anchors = r.dropped.filter((d) => d.reason === 'anchor_unresolved' || d.reason === 'run_unresolved').length;
  const tail = dropped === 0 ? '' : `; ${dropped} dropped${anchors > 0 ? ` (${anchors} with anchors that did not resolve)` : ''}`;
  return `${parts.join(', ')} filed as pending${tail}`;
}
