import { z } from 'zod';
import {
  zAgentKind, zCaptureMethod, zConfidence, zDerivedStatus, zFreshness, zIso, zUuid, zVisibility,
} from './common.ts';

export const zAgentState = z.object({
  computed_at: zIso,
  coverage_end: zIso,
  doing_now: z.string(),
  last_action: z.object({
    at: zIso.nullable(),
    files: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }).nullable(),
  blockers: z.array(z.string()),
  recent_artifacts: z.array(z.string()),
  confidence: zConfidence,
  /** One-click expansion back to the raw run (R16). Never omitted. */
  source_run_ids: z.array(zUuid),
  prompt_version: z.string(),
});

export const zAgentCard = z.object({
  id: zUuid,
  name: z.string(),
  kind: zAgentKind,
  project_id: zUuid.nullable(),
  visibility: zVisibility,
  derived_status: zDerivedStatus,
  last_active_at: zIso.nullable(),
  has_open_action: z.boolean(),
  state: zAgentState.nullable(),
  /** Set when summarize-state failed and the previous state is shown (13.3). */
  stale_state: z.boolean(),
  /**
   * v1.2 (plan 7.1): an active line silent past workspaces.archive_prompt_days
   * and not snoozed. The dashboard shows three buttons on it; nothing happens
   * until one is pressed.
   */
  needs_archive_prompt: z.boolean().default(false),
});

/** The three answers to the archive prompt. */
export const zArchiveAction = z.object({
  action: z.enum(['seal', 'done', 'snooze']),
  /** For snooze: how long to stay quiet. Default 21 days. */
  snooze_days: z.number().int().min(1).max(365).optional(),
});
export type ArchiveAction = z.infer<typeof zArchiveAction>;

export const zDashboardResponse = z.object({
  freshness: zFreshness,
  agents: z.array(zAgentCard),
  unbound_runs: z.number().int().nonnegative(),
  pending_entries: z.number().int().nonnegative(),
});

export const zAgentBindRequest = z.object({
  type: z.enum(['repo_path', 'conversation_id', 'project_hint', 'platform_project']),
  value: z.string().min(1),
});

/** Four scopes, narrow to wide (10.2). No `write` dimension, by design. */
export const zGrantScope = z.discriminatedUnion('scope_type', [
  z.object({ scope_type: z.literal('agent'), scope_id: zUuid }),
  z.object({ scope_type: z.literal('project'), scope_id: zUuid }),
  z.object({ scope_type: z.literal('entry_type'), entry_type: z.string() }),
  z.object({ scope_type: z.literal('workspace_entries') }),
]);

export const zGrantCreateRequest = z.object({
  agent_id: zUuid,
  scope: zGrantScope,
  expires_at: zIso.nullable().optional(),
});

export const zGrant = z.object({
  id: zUuid,
  agent_id: zUuid,
  scope_type: z.string(),
  scope_id: zUuid.nullable(),
  entry_type: z.string().nullable(),
  granted_by: zUuid,
  expires_at: zIso.nullable(),
  revoked_at: zIso.nullable(),
  /** False when the grant is expired, revoked, or the granter left the
   *  workspace. The UI must show why a grant stopped working (13.3). */
  effective: z.boolean(),
  created_at: zIso,
});

export type AgentCard = z.infer<typeof zAgentCard>;
export type DashboardResponse = z.infer<typeof zDashboardResponse>;
export type AgentStateDto = z.infer<typeof zAgentState>;

/** Settings → Sources: the two per-source switches (arch v1.2 0.7). */
export const zSourcePatch = z.object({
  label: z.string().max(80).nullable().optional(),
  upload_diffs: z.boolean().optional(),
  /** One-way in the API as well as in the ratchet: general → medical only. */
  profile: z.literal('medical').optional(),
});
export type SourcePatch = z.infer<typeof zSourcePatch>;

/**
 * POST /api/v1/sources -- a capturing machine registers itself.
 *
 * Until this existed a source row came only from the bootstrap script's raw
 * SQL, so `actario init` asked the user for a UUID they had no way to obtain.
 * `capture_method` is the DB's closed set; `platform` is free text because a
 * local machine scans every adapter under one source ('local' is the honest
 * default). `label` defaults to the hostname on the client so a workspace with
 * three laptops can tell them apart on the Sources page.
 */
export const zSourceCreate = z.object({
  platform: z.string().min(1).max(40).default('local'),
  capture_method: zCaptureMethod.default('local_file'),
  label: z.string().min(1).max(80).nullable().optional(),
  profile: z.enum(['general', 'medical']).default('general'),
});
export type SourceCreate = z.infer<typeof zSourceCreate>;

export const zSourceDto = z.object({
  id: zUuid,
  workspace_id: zUuid,
  user_id: zUuid,
  platform: z.string(),
  capture_method: zCaptureMethod,
  label: z.string().nullable(),
  profile: z.enum(['general', 'medical']),
  upload_diffs: z.boolean(),
  created_at: zIso,
});
export type SourceDto = z.infer<typeof zSourceDto>;

/** Settings → Workspace. */
export const zWorkspacePatch = z.object({
  name: z.string().min(1).max(80).optional(),
  retention_days: z.number().int().min(30).max(36500).optional(),
  archive_prompt_days: z.number().int().min(7).max(365).optional(),
});
export type WorkspacePatch = z.infer<typeof zWorkspacePatch>;

/** Settings → Tokens. */
export const zTokenCreate = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(['read', 'capture'])).min(1),
});
export type TokenCreate = z.infer<typeof zTokenCreate>;
