import { z } from 'zod';

// Shared vocabulary. One definition, three apps (arch 11.3).
export const zUuid = z.string().uuid();
export const zIso = z.string().datetime({ offset: true });

export const zVisibility = z.enum(['private', 'workspace', 'shared_link']);
export const zEntryType = z.enum(['decision', 'action', 'fact', 'question', 'risk', 'progress']);
export const zEntryStatus = z.enum(['pending', 'confirmed', 'rejected', 'open', 'done']);
export const zAgentKind = z.enum(['chat_role', 'coding_session', 'script', 'workflow']);
/** Five states, not four: `quiet` separates "nothing pending" from "stuck" (8.5). */
export const zDerivedStatus = z.enum(['active', 'quiet', 'stalled', 'idle', 'done', 'archived']);
export const zConfidence = z.enum(['high', 'medium', 'low']);
export const zParseLevel = z.enum(['strict', 'loose', 'raw']);
export const zUploadStatus = z.enum([
  'initiated', 'received', 'ingesting', 'analyzing', 'completed', 'partial', 'failed',
]);
export const zCaptureMethod = z.enum([
  'account_export', 'compliance_api', 'local_file', 'agent_session',
]);
export const zTokenScope = z.enum(['read', 'capture']);

export const zFreshness = z.object({
  coverage_end: zIso.nullable(),
  data_age_days: z.number().int().nullable(),
  stale: z.boolean(),
});

export const zErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export type Freshness = z.infer<typeof zFreshness>;
export type EntryType = z.infer<typeof zEntryType>;
export type ParseLevel = z.infer<typeof zParseLevel>;
export type DerivedStatus = z.infer<typeof zDerivedStatus>;

/**
 * GET /api/v1/me -- what this token is. No identity parameters go in (the
 * token decides everything, appendix D); what comes out is enough for a
 * client to know whether it may write before it tries, and for an agent to
 * know it is reading as an agent (the `scope_note` idea from appendix D, one
 * level up). `kind: 'agent'` from here is how `actario mcp` learns it was
 * handed a token it must refuse.
 */
export const zMeResponse = z.object({
  kind: z.enum(['user', 'agent']),
  scopes: z.array(z.string()),
  workspace_id: zUuid.nullable(),
  /** Set for kind = 'user'. */
  user_id: zUuid.nullable(),
  /** Set for kind = 'agent'. */
  agent_id: zUuid.nullable(),
  via: z.enum(['session', 'pat']),
  can_capture: z.boolean(),
});
export type MeResponse = z.infer<typeof zMeResponse>;
