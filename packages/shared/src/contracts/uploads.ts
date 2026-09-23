import { z } from 'zod';
import { zIso, zUploadStatus, zUuid } from './common.ts';

/** manifest.json file entry (arch 7.1). sha256 is mandatory: /complete verifies it. */
export const zManifestFile = z.object({
  name: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, 'unsafe file name'),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const zCaptureReport = z.object({
  cqs: z.number().int().min(0).max(100),
  cqs_version: z.string(),
  runs_total: z.number().int().nonnegative(),
  runs_kept: z.number().int().nonnegative(),
  runs_dropped: z.number().int().nonnegative(),
  parse_levels: z.object({
    strict: z.number().int().nonnegative(),
    loose: z.number().int().nonnegative(),
    raw: z.number().int().nonnegative(),
  }),
  coverage_start: zIso.nullable(),
  coverage_end: zIso.nullable(),
  coverage_gap_pct: z.number().min(0).max(100),
  truncation_pct: z.number().min(0).max(100),
  /**
   * v1.2: share of turns whose tool_result hit the 8 KB cap. Reported, never
   * scored -- the cap is a design decision, and this number is the evidence
   * for open question #9 (is 8 KB right), not a defect count.
   */
  result_truncated_pct: z.number().min(0).max(100).default(0),
  /**
   * Substance counts, not just field presence.
   *
   * "artifacts unreadable" tells you a field came back empty; it does not tell
   * you whether that was 1 run of 49 or all of them. Without the ratio there is
   * no way to tell a genuinely tool-free session apart from a format change,
   * which is exactly the judgement CQS is trying to support (6.2).
   */
  tool_calls_total: z.number().int().nonnegative(),
  artifacts_total: z.number().int().nonnegative(),
  runs_with_tool_calls: z.number().int().nonnegative(),
  runs_with_artifacts: z.number().int().nonnegative(),
  /** Fields the source SHOULD have had but this parse could not read (6.2). */
  degraded_fields: z.array(z.string()),
  /** Fields the source never had. Deliberately does not cost CQS points (6.2). */
  absent_by_capability: z.array(z.string()),
  redactions: z.record(z.string(), z.number().int().nonnegative()),
  warnings: z.array(z.string()),
  adapters: z.array(z.object({
    adapter_id: z.string(),
    adapter_version: z.string(),
    runs: z.number().int().nonnegative(),
    ok: z.boolean(),
    error: z.string().optional(),
  })),
});

export const zBundleMeta = z.object({
  bundle_id: zUuid,
  ucf_version: z.literal('0.2'),
  cli_version: z.string(),
  created_at: zIso,
  host_os: z.string(),
  redaction_profile: z.enum(['medical', 'general']),
  hard_rules_enforced: z.literal(true), // C6: not a negotiable field
});

export const zUploadsInitRequest = z.object({
  source_id: zUuid,
  bundle_meta: zBundleMeta,
  capture_report: zCaptureReport,
  files: z.array(zManifestFile).min(1).max(2000),
});

export const zUploadsInitResponse = z.object({
  upload_id: zUuid,
  urls: z.array(z.object({ name: z.string(), signed_url: z.string().url() })),
  expires_at: zIso,
  /** True when the idempotency key matched an existing upload (7.3). */
  resumed: z.boolean(),
});

export const zUploadsCompleteRequest = z.object({
  files: z.array(z.object({
    name: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1),
});

export const zUploadsCompleteResponse = z.object({
  upload_id: zUuid,
  status: zUploadStatus,
});

/** 409 body when the manifest and the stored objects disagree (7.2). */
export const zManifestMismatch = z.object({
  error: z.object({
    code: z.literal('manifest_mismatch'),
    message: z.string(),
    details: z.object({
      missing: z.array(z.string()),
      hash_mismatch: z.array(z.string()),
      unexpected: z.array(z.string()),
    }),
  }),
});

export const zUploadStatusResponse = z.object({
  upload_id: zUuid,
  status: zUploadStatus,
  quality_score: z.number().int().nullable(),
  cqs_version: z.string().nullable(),
  capture_report: zCaptureReport.nullable(),
  dropped_runs: z.array(z.object({
    run_ref: z.string(),
    reason: z.string(),
    parse_level: z.string().optional(),
  })),
  error_code: z.string().nullable(),
  runs_ingested: z.number().int().nonnegative().nullable(),
  created_at: zIso,
  /**
   * v1.3: the verdict on the last DAF received for this upload (arch 18.5).
   * Shape is @distill/daf's DafValidationReport; kept opaque here so the
   * shared contract does not depend on the analysis package. null until a
   * DAF has been validated.
   */
  daf_validation_report: z.record(z.string(), z.unknown()).nullable().default(null),
});

/**
 * POST /api/v1/uploads/{id}/analysis (arch v1.3 18.8). The body is the DAF
 * itself, validated against @distill/daf in the route; this is the reply.
 * 202, not 200: the gate runs in fn:analyze, and the CLI polls
 * GET /uploads/{id} for daf_validation_report.
 */
export const zAnalysisSubmitResponse = z.object({
  upload_id: zUuid,
  /** Storage path of the stored DAF (bundles/<bundle_ref>/daf/<id>.json). */
  daf_ref: z.string(),
  status: z.literal('queued'),
  /** Pass-1 counts, so the CLI can say "sent N entries" before the verdict. */
  received: z.object({
    segments: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    agent_states: z.number().int().nonnegative(),
  }),
});
export type AnalysisSubmitResponse = z.infer<typeof zAnalysisSubmitResponse>;

export type ManifestFile = z.infer<typeof zManifestFile>;
export type CaptureReport = z.infer<typeof zCaptureReport>;
export type BundleMeta = z.infer<typeof zBundleMeta>;
export type UploadsInitRequest = z.infer<typeof zUploadsInitRequest>;
export type UploadsInitResponse = z.infer<typeof zUploadsInitResponse>;
export type UploadStatusResponse = z.infer<typeof zUploadStatusResponse>;
