import { z } from 'zod';
import { DAF_LIMITS as L } from './limits.ts';

/**
 * DAF v0.2 -- the analysis exchange format (arch v1.3 §18.3).
 *
 * UCF carries the conversation up; DAF carries what a model concluded about
 * it. The two travel separately on purpose: `capture` is deterministic and
 * must always land, `analyze` is a model run and may fail, and a failure in
 * the second must not be able to cost the first (§18.8).
 *
 * The one rule that shapes every reference in this file: **the client does
 * not know the server's UUIDs** (§18.4). `runs.id` and `turns.id` are assigned
 * at ingest. So every anchor is a `(run_hash, turn_idx)` pair, resolved by the
 * server at validation time. A UUID in a DAF is a fabricated one, and the
 * resolver rejects it by construction because no hash matches.
 *
 * **Why the hash and not the run_ref (v0.2, the first real bundle proved it).**
 * §18.4 specified `(run_ref, turn_idx)` on the assumption that a UCF run_ref
 * identifies one run. It does not: `claude_code_session` sets
 * `run_ref = sessionId`, and one session id routinely spans many runs -- the
 * first real capture had 49 runs under 7 distinct run_refs, one of them
 * covering 33. A resolver handed an ambiguous run_ref must either refuse the
 * entry or pick a run, and picking is the worse failure: the entry lands
 * against the wrong conversation carrying a source link that looks perfectly
 * valid, which is precisely the fabricated citation C1 exists to make
 * impossible.
 *
 * `runs.content_hash` is the coordinate that actually works. The client has it
 * (the capture pipeline computes it and stores it in the bundle), the server
 * has it, it is derived from the conversation so it survives re-capture, and
 * `unique (workspace_id, content_hash)` means it can never be ambiguous. It is
 * also, not coincidentally, what the server already deduplicates on -- the
 * coordinate was in the bundle the whole time.
 *
 * Everything in a DAF is untrusted (C8). The schema is the first gate; the
 * resolver in resolve.ts is the second; the fields the server overwrites
 * regardless of what the client sent are listed in report.ts.
 */
export const DAF_VERSION = '0.2' as const;

/**
 * The rubric version the skill writes against (skill/references/analysis-rubric.md).
 * Bumped when the rubric changes in a way that would move the drop rate or
 * the entry mix; recorded per row as client_prompt_version so evals can
 * split on it (§18.9).
 */
export const CLIENT_PROMPT_VERSION = 'client-notes@2026-10-04' as const;

const ref = z.string().min(1).max(L.refMax);
/**
 * The run coordinate: `runs.content_hash`, copied from the bundle verbatim.
 * Not pinned to hex -- ingest falls back to `<adapter_id>:<run_ref>` when a
 * run carries no hash, and the DAF must be able to name such a run too.
 */
const runHash = z.string().min(8).max(L.hashMax);
const idx = z.number().int().nonnegative();
/** ISO 8601 with offset -- the same shape UCF uses for timestamps. */
const iso = z.string().datetime({ offset: true });

export const zDafAnalyzer = z.object({
  /**
   * agent_session -- the user's own agent (Claude Code, Cowork, Cursor …)
   *                  read the batch and wrote this file
   * cli_local_model -- `actario analyze` drove a local model itself
   * server -- produced by fn:analyze's own LLM path; only ever seen in
   *           evals/, where the two origins are compared side by side
   */
  kind: z.enum(['agent_session', 'cli_local_model', 'server']),
  /** Self-reported. Recorded for evals, never a basis for trust (§18.9). */
  model: z.string().max(200).nullable().default(null),
  skill_version: z.string().max(60).nullable().default(null),
  /** Which rubric wrote this. Recorded per row as client_prompt_version. */
  prompt_version: z.string().min(1).max(120),
  produced_at: iso,
});

export const zDafSegment = z.object({
  run_hash: runHash,
  /** Informational: which session this run came from. Never used to resolve (see above). */
  run_ref: ref.nullable().default(null),
  start_turn_idx: idx,
  end_turn_idx: idx,
  topic: z.string().max(L.topicMax).nullable().default(null),
  summary: z.string().max(L.summaryMax).nullable().default(null),
  labels: z.array(z.string().min(1).max(L.labelMax)).max(L.labelsPerSegment).default([]),
}).refine((s) => s.end_turn_idx >= s.start_turn_idx, {
  message: 'end_turn_idx must be >= start_turn_idx', path: ['end_turn_idx'],
});

export const DAF_ENTRY_TYPES = ['decision', 'action', 'fact', 'question', 'risk', 'progress'] as const;
export type DafEntryType = (typeof DAF_ENTRY_TYPES)[number];
export const isDafEntryType = (t: string): t is DafEntryType => (DAF_ENTRY_TYPES as readonly string[]).includes(t);

/**
 * Two of §18.5's rules meet in this object and they have different
 * consequences, so they live in different places:
 *
 *   rule 1 -- shape and string caps: the WHOLE DAF is refused. Enforced here.
 *   rule 6 -- `type` outside the closed set, `confidence` outside [0, 1]:
 *             THAT ENTRY is dropped, the batch lands. So the schema only pins
 *             the primitive type, and resolve.ts checks the value per item
 *             (`invalid_field`).
 */
export const zDafEntry = z.object({
  type: z.string().min(1).max(L.labelMax),
  title: z.string().min(3).max(L.titleMax),
  body: z.string().min(1).max(L.bodyMax),
  confidence: z.number(),
  occurred_at: iso.nullable().default(null),
  run_hash: runHash,
  /** Informational: which session this run came from. Never used to resolve (see above). */
  run_ref: ref.nullable().default(null),
  /** The anchors. Every one must resolve, or the entry is dropped (§18.5 rule 3). */
  source_turn_idx: z.array(idx).min(1).max(L.anchorsPerEntry),
  /** For decisions: what was considered and turned down. The highest-value field in the rubric. */
  rejected_options: z.array(z.string().min(1).max(L.rejectedOptionMax)).max(L.rejectedOptionsPerEntry).default([]),
  /** Free-form entity refs ("component:waveform-writer"). Stored verbatim until the entities table exists. */
  entities: z.array(z.string().min(1).max(L.entityRefMax)).max(L.entitiesPerEntry).default([]),
  // No `status`, no `open`, no `visibility`: every lifecycle field is the
  // server's (C8), and an accepted-but-ignored key would teach the client to
  // send it. Unknown keys are stripped.
});

export const zDafAgentState = z.object({
  /** The agent_ref from the bundle's agents.json. Advisory: the server resolves via the source runs (§18.2). */
  agent_ref: ref.nullable().default(null),
  doing_now: z.string().min(1).max(L.doingNowMax),
  last_action: z.object({
    summary: z.string().min(1).max(L.doingNowMax),
    at: iso.nullable().default(null),
  }).nullable().default(null),
  blockers: z.array(z.string().min(1).max(L.blockerMax)).max(L.blockersPerState).default([]),
  recent_artifacts: z.array(z.string().min(1).max(L.artifactPathMax)).max(L.artifactsPerState).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  /** The runs this card rests on. Resolved to runs.id; their agent_id is the card's agent. */
  source_run_hashes: z.array(runHash).min(1).max(L.sourceRunsPerState),
});

/**
 * One section of a run's note page: a heading, a Markdown body, and the
 * stretch of the conversation it is about. The range is the section's
 * citation -- the web links it back to the run page at `#t<start>` -- so it is
 * held to the same rule as a segment's: both ends must be real turns of that
 * run, or the page does not land (resolve.ts).
 */
export const zDafPageSection = z.object({
  // Trimmed, as the database stores it: a heading of spaces passes a plain
  // min(1) and then fails the table's check inside the gate.
  heading: z.string().trim().min(1).max(L.sectionHeadingMax),
  start_turn_idx: idx,
  end_turn_idx: idx,
  /** Markdown. Rendered through the same AST reader as captured turns, so it cannot inject markup. */
  body: z.string().min(1).max(L.sectionBodyMax),
}).refine((s) => s.end_turn_idx >= s.start_turn_idx, {
  message: 'end_turn_idx must be >= start_turn_idx', path: ['end_turn_idx'],
});

/**
 * A note page (2026-10-04): the whole run written up as a document -- what
 * the Confluence page about this conversation would say -- by the user's own
 * agent, from the redacted bundle `read_run` returns. One per run. Additive to
 * v0.2: a DAF without `pages` means exactly what it meant before.
 */
export const zDafPage = z.object({
  run_hash: runHash,
  /** Informational, as on segments. Never used to resolve. */
  run_ref: ref.nullable().default(null),
  title: z.string().trim().min(1).max(L.pageTitleMax),
  /** The panel at the top of the page: what this conversation was for and where it ended up. */
  summary: z.string().max(L.pageSummaryMax).nullable().default(null),
  labels: z.array(z.string().min(1).max(L.labelMax)).max(L.labelsPerSegment).default([]),
  sections: z.array(zDafPageSection).min(1).max(L.sectionsPerPage),
});

export const zDaf = z.object({
  daf_version: z.literal(DAF_VERSION),
  /** The bundle this analysis is of. Must equal the upload's manifest bundle_id. */
  bundle_id: z.string().uuid(),
  analyzer: zDafAnalyzer,
  segments: z.array(zDafSegment).default([]),
  entries: z.array(zDafEntry).default([]),
  agent_states: z.array(zDafAgentState).default([]),
  /** Note pages, one per run. Optional: absent and [] are the same. */
  pages: z.array(zDafPage).default([]),
});

export type Daf = z.infer<typeof zDaf>;
export type DafInput = z.input<typeof zDaf>;
export type DafAnalyzer = z.infer<typeof zDafAnalyzer>;
export type DafSegment = z.infer<typeof zDafSegment>;
export type DafEntry = z.infer<typeof zDafEntry>;
export type DafAgentState = z.infer<typeof zDafAgentState>;
export type DafPage = z.infer<typeof zDafPage>;
export type DafPageSection = z.infer<typeof zDafPageSection>;

/** Parse, or explain. The message is what the CLI prints and what lands in the report on schema failure. */
export function parseDaf(input: unknown): { ok: true; daf: Daf } | { ok: false; issues: { path: string; message: string }[] } {
  const r = zDaf.safeParse(input);
  if (r.success) return { ok: true, daf: r.data };
  return {
    ok: false,
    issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}
