import { z } from 'zod';
import { zEntryStatus, zEntryType, zIso, zUuid, zVisibility } from './common.ts';

export const zEntrySource = z.object({
  turn_id: zUuid,
  ord: z.number().int().nonnegative(),
  run_id: zUuid.nullable(),
  excerpt: z.string().nullable(),
  /** Null after the retention sweep cleared turns.content (13.4). */
  content_available: z.boolean(),
});

export const zEntry = z.object({
  id: zUuid,
  type: zEntryType,
  title: z.string(),
  body: z.string(),
  status: zEntryStatus,
  visibility: zVisibility,
  confidence: z.number().min(0).max(1).nullable(),
  occurred_at: zIso.nullable(),
  project_id: zUuid.nullable(),
  agent_id: zUuid.nullable(),
  run_id: zUuid.nullable(),
  superseded_by: zUuid.nullable(),
  sources: z.array(zEntrySource).min(1), // C1 structural half: never empty
  created_at: zIso,
});

export const zEntriesQuery = z.object({
  type: zEntryType.optional(),
  status: zEntryStatus.optional(),
  project_id: zUuid.optional(),
  agent_id: zUuid.optional(),
  since: zIso.optional(),
  until: zIso.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const zEntryPatchRequest = z.object({
  status: zEntryStatus.optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  visibility: zVisibility.optional(),
  superseded_by: zUuid.nullable().optional(),
});

/** The other half of the 80% anchor threshold: fixing it must cost five
 *  seconds (9.4). Without this the threshold is just a lower standard. */
export const zEntrySourceFeedbackRequest = z.object({
  verdict: z.enum(['correct', 'wrong', 'incomplete']),
  turn_id: zUuid.optional(),
  corrected_turn_ids: z.array(zUuid).optional(),
});

export const zSearchQuery = z.object({
  q: z.string().min(1).max(400),
  type: zEntryType.optional(),
  project_id: zUuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Search results carry no total count, on purpose: a count would leak
 * "there are N rows you cannot see" (10.5, rule 1).
 */
export const zSearchResponse = z.object({
  results: z.array(zEntry.extend({ score: z.number() })),
});

export type Entry = z.infer<typeof zEntry>;
export type EntriesQuery = z.infer<typeof zEntriesQuery>;

/**
 * Who may confirm an entry (C8, §18.6) -- `workspaces.entry_review_policy`.
 *
 * `allow_all` is the interim decided 2026-09-23: entries are confirmed on
 * arrival until a review program exists. The version string is written onto
 * every row the policy confirms, so the program can later re-review exactly
 * those rows and nothing a person decided. Bump the version if the policy's
 * meaning changes; keep migration 20260923000100's backfill string in sync.
 */
export type ReviewPolicy = 'human' | 'allow_all';

export const REVIEW_POLICY_VERSIONS = {
  allow_all: 'allow_all@2026-09-23',
} as const;

/** The review fields an analysis write carries, given the workspace policy. */
export type EntryLanding =
  | { status: 'pending'; review_source: null; review_version: null }
  | { status: 'confirmed'; review_source: 'policy'; review_version: string };

/**
 * What a freshly analysed claim lands as. Only for claims that would otherwise
 * wait in the Inbox: server-written actions keep their own open/done
 * lifecycle and never pass through here.
 *
 * Anything other than exactly 'allow_all' -- including a value this code does
 * not know yet -- lands pending. Failing closed is the only safe reading of a
 * policy you do not recognise.
 */
export function entryLanding(policy: string | null | undefined): EntryLanding {
  if (policy === 'allow_all') {
    return { status: 'confirmed', review_source: 'policy', review_version: REVIEW_POLICY_VERSIONS.allow_all };
  }
  return { status: 'pending', review_source: null, review_version: null };
}
