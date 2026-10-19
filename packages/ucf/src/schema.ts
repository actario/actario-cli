import { z } from 'zod';

/**
 * UCF v0.2 -- the single definition of the capture format (arch 5, appendix F).
 *
 * Two things about this file are load-bearing:
 *
 * 1. `raw_ext` exists at every level. Any key an adapter does not recognise is
 *    stored verbatim rather than dropped (6.3 rule 1). It is the cheapest
 *    line in the whole compatibility story: a backfill job can rescue history
 *    later, but a key thrown away today is gone forever.
 *
 * 2. Required vs expected is a real distinction. `role` and `content` are
 *    required -- without them there is no turn. Everything else is expected at
 *    most: missing expected fields degrade the run (and cost CQS points only
 *    when the source claimed to have them), they never discard it (C5).
 */
export const UCF_VERSION = '0.2' as const;

/**
 * Upload-scope limits (arch v1.2 0.7; plan v1.4 5.6.1).
 *
 * v1.1 kept tool parameters as shape only and never moved tool results or
 * diff bodies at all. v1.4 makes the de-identified corpus a product goal, and
 * a corpus is worth more the more complete each record is, so all three now
 * travel -- capped, and after hard redaction (C6), which the widened scope
 * does not loosen: a credential inside a corpus is worth nothing and costs
 * someone a production environment.
 *
 * The result cap is open question #9. 8 KB is the starting value; the
 * `result_truncated` hit rate is what decides whether it moves, and that
 * number belongs in evals/ next to the redaction precision figure.
 */
export const TOOL_RESULT_MAX_BYTES = 8 * 1024;
/** Per string value inside tool params. A `Write` of a 2,000-line file is
 *  legitimately large; a param past this is almost certainly a binary blob. */
export const TOOL_PARAM_MAX_CHARS = 64 * 1024;
export const DIFF_BODY_MAX_CHARS = 64 * 1024;

const rawExt = z.record(z.string(), z.unknown()).default({});

export const zToolCall = z.object({
  name: z.string(),
  /**
   * Full parameters since v1.2 (file bodies included), capped per value at
   * TOOL_PARAM_MAX_CHARS. Redaction runs over them before anything leaves the
   * machine (C6).
   */
  params: z.record(z.string(), z.unknown()).optional(),
  ok: z.boolean().optional(),
  ms: z.number().nonnegative().optional(),
  raw_ext: rawExt,
});

export const zUcfTurn = z.object({
  idx: z.number().int().nonnegative(),
  role: z.string().min(1),                       // required
  content: z.string(),                           // required (may be empty string)
  timestamp: z.string().datetime({ offset: true }).nullable().default(null),
  tool_calls: z.array(zToolCall).nullable().default(null),
  branch_id: z.string().nullable().default(null),
  parent_turn_ref: z.number().int().nonnegative().nullable().default(null),
  /** The turn's own text was cut. Counts against CQS. */
  truncated: z.boolean().default(false),
  /**
   * Tool output attached to this turn, capped at TOOL_RESULT_MAX_BYTES. Kept
   * out of `content` so it can be capped and scored separately: a 2,000-line
   * `Read` result is not the conversation, it is what the conversation looked
   * at.
   */
  tool_result: z.string().nullable().default(null),
  /**
   * tool_result hit the cap. A design decision, not data loss -- so this flag
   * is NEVER folded into the CQS truncation rate. Mixing them would make the
   * score drop for something the format did on purpose (the ADR 14 mistake).
   */
  result_truncated: z.boolean().default(false),
  raw_ext: rawExt,
});

export const zUcfArtifact = z.object({
  path: z.string().min(1),
  change: z.enum(['created', 'modified', 'deleted']),
  /** The statistics line -- "+218 -0". Always present when diff_body is. */
  diff_summary: z.string().nullable().default(null),
  /**
   * The diff itself, since v1.2, when the source has `upload_diffs` on
   * (default on; a paid-tier switch later). Capped at DIFF_BODY_MAX_CHARS.
   */
  diff_body: z.string().nullable().default(null),
  sha256: z.string().nullable().default(null),
  raw_ext: rawExt,
});

export const zBindingHint = z.object({
  type: z.enum(['repo_path', 'conversation_id', 'project_hint', 'platform_project']),
  value: z.string().min(1),
});

export const zUcfAgent = z.object({
  agent_ref: z.string().min(1),                  // local id, resolved server-side
  name: z.string().min(1),
  kind: z.enum(['chat_role', 'coding_session', 'script', 'workflow']),
  bindings: z.array(zBindingHint).default([]),
  raw_ext: rawExt,
});

export const zUcfRun = z.object({
  run_ref: z.string().min(1),
  agent_ref: z.string().nullable().default(null), // null -> unbound queue (13.3)
  platform: z.string().min(1),
  model: z.string().nullable().default(null),
  started_at: z.string().datetime({ offset: true }).nullable().default(null),
  ended_at: z.string().datetime({ offset: true }).nullable().default(null),
  outcome: z.enum(['completed', 'interrupted', 'failed', 'ongoing']).nullable().default(null),
  title: z.string().nullable().default(null),
  binding_hints: z.array(zBindingHint).default([]),
  turns: z.array(zUcfTurn).min(1),
  artifacts: z.array(zUcfArtifact).default([]),

  // ── provenance of the parse itself (C5) ──
  parse_level: z.enum(['strict', 'loose', 'raw']).default('strict'),
  adapter_id: z.string(),
  adapter_version: z.string(),
  /** Expected-but-unreadable fields. Drives confidence='low' in the UI. */
  degraded_fields: z.array(z.string()).default([]),
  /** Fields this source never had at all. Costs no CQS points (6.2). */
  absent_by_capability: z.array(z.string()).default([]),
  raw_ext: rawExt,
});

/** What an adapter returns before validation fills in the defaults. */
export const zUcfRunDraft = zUcfRun.partial({
  parse_level: true,
  degraded_fields: true,
  absent_by_capability: true,
  artifacts: true,
  binding_hints: true,
  raw_ext: true,
});

/**
 * The logical single-object form. Real transfers use split NDJSON (7.1) --
 * one `zUcfRun` per line -- but the logical schema is identical, and test
 * fixtures use this shape.
 */
export const zUcfBundle = z.object({
  ucf_version: z.literal(UCF_VERSION),
  agents: z.array(zUcfAgent).default([]),
  runs: z.array(zUcfRun).default([]),
  raw_ext: rawExt,
});

export type ToolCall = z.infer<typeof zToolCall>;
export type UcfTurn = z.infer<typeof zUcfTurn>;
export type UcfArtifact = z.infer<typeof zUcfArtifact>;
export type UcfAgent = z.infer<typeof zUcfAgent>;
export type UcfRun = z.infer<typeof zUcfRun>;
export type UcfRunDraft = z.input<typeof zUcfRun>;
export type UcfBundle = z.infer<typeof zUcfBundle>;
export type BindingHint = z.infer<typeof zBindingHint>;
