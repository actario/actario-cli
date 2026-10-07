import { z } from 'zod';
import { zIso, zUuid } from './common.ts';

/**
 * Restore and memory (arch v2.1 ch. 22, plugin 0.1.7a, CLI 0.1.4).
 *
 * The first time data travels back from the platform into a conversation.
 * Every shape here is something the server *stores and hands back*; none of
 * it is written by the server. Transcripts are the masked turns exactly as
 * ingested, memory packs are text the user's own agent wrote on the user's
 * own machine (decision #56). The server checks format and anchors (C8) and
 * controls who gets what; it does not write, summarise or compact.
 *
 * Who may call: a person (browser session or personal token). Never an agent
 * token -- an agent reading another line of work goes through the reflow
 * MCP (ch. 12, C4), not through here.
 */

// ── GET /api/v1/runs ──

export const zRunsQuery = z.object({
  /** Words in the title. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Agent id, or the agent's name (case-insensitive, exact). */
  agent: z.string().trim().min(1).max(200).optional(),
  /** ISO date or date-time: runs that started at or after it. */
  since: z.string().trim().min(4).max(40).optional(),
  until: z.string().trim().min(4).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque: the `next_cursor` of the previous page. */
  cursor: z.string().max(200).optional(),
});
export type RunsQuery = z.infer<typeof zRunsQuery>;

export const zRunListItem = z.object({
  id: zUuid,
  /** The run's coordinate: what the capture pipeline hashed. DAF anchors and memory anchors use it. */
  run_hash: z.string(),
  title: z.string().nullable(),
  platform: z.string(),
  model: z.string().nullable(),
  started_at: zIso,
  ended_at: zIso.nullable(),
  outcome: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  has_page: z.boolean(),
  agent: z.object({ id: zUuid, name: z.string() }).nullable(),
  workspace_id: zUuid,
});
export type RunListItem = z.infer<typeof zRunListItem>;

export const zRunsResponse = z.object({
  runs: z.array(zRunListItem),
  next_cursor: z.string().nullable(),
});
export type RunsResponse = z.infer<typeof zRunsResponse>;

// ── GET /api/v1/runs/{id}/transcript ──

/** What can ride along with the turns. Asked for, not sent by default: most pages after the first need none of it. */
export const TRANSCRIPT_INCLUDES = ['segments', 'page', 'artifacts'] as const;
export type TranscriptInclude = (typeof TRANSCRIPT_INCLUDES)[number];

export const zTranscriptQuery = z.object({
  /** First turn idx of the page (inclusive). */
  from: z.coerce.number().int().min(0).default(0),
  /** Turns per page. */
  limit: z.coerce.number().int().min(1).max(500).default(200),
  include: z.string().max(100).optional().transform((s, ctx) => {
    if (!s) return [] as TranscriptInclude[];
    const parts = [...new Set(s.split(',').map((p) => p.trim()).filter(Boolean))];
    for (const p of parts) {
      if (!(TRANSCRIPT_INCLUDES as readonly string[]).includes(p)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown include "${p}" (one of ${TRANSCRIPT_INCLUDES.join(', ')})` });
        return z.NEVER;
      }
    }
    return parts as TranscriptInclude[];
  }),
});
export type TranscriptQuery = z.infer<typeof zTranscriptQuery>;

export const zTranscriptTurn = z.object({
  idx: z.number().int(),
  role: z.string(),
  content: z.string(),
  timestamp: zIso.nullable(),
  /** Names, status and (already stripped) parameters -- a description, not a replayable call (22.1). */
  tool_calls: z.unknown().nullable(),
  /** Capped at 8 KB by capture (open #9). */
  tool_result: z.string().nullable(),
  result_truncated: z.boolean(),
  /** Set when retention cleared the text and kept the skeleton (13.4). */
  content_cleared: z.boolean(),
});
export type TranscriptTurn = z.infer<typeof zTranscriptTurn>;

export const zTranscriptSegment = z.object({
  start_turn_idx: z.number().int(),
  end_turn_idx: z.number().int(),
  topic: z.string().nullable(),
  summary: z.string().nullable(),
  labels: z.array(z.string()),
});
export type TranscriptSegment = z.infer<typeof zTranscriptSegment>;

export const zTranscriptPageSection = z.object({
  heading: z.string(),
  start_turn_idx: z.number().int().nullable(),
  end_turn_idx: z.number().int().nullable(),
  body: z.string(),
});

export const zTranscriptPage = z.object({
  title: z.string(),
  summary: z.string().nullable(),
  labels: z.array(z.string()),
  sections: z.array(zTranscriptPageSection),
  version: z.number().int(),
  origin: z.enum(['agent', 'human']),
  updated_at: zIso,
});
export type TranscriptPage = z.infer<typeof zTranscriptPage>;

export const zTranscriptArtifact = z.object({
  path: z.string(),
  change: z.string(),
  /** Statistics only. The diff body is never handed back for restore (22.1). */
  diff_summary: z.string().nullable(),
});

export const zTranscriptRun = zRunListItem.omit({ has_page: true });
export type TranscriptRun = z.infer<typeof zTranscriptRun>;

export const zTranscriptResponse = z.object({
  run: zTranscriptRun,
  turns: z.array(zTranscriptTurn),
  /** idx to pass as `from` for the next page; null on the last page. */
  next_from: z.number().int().nullable(),
  segments: z.array(zTranscriptSegment).optional(),
  page: zTranscriptPage.nullable().optional(),
  artifacts: z.array(zTranscriptArtifact).optional(),
});
export type TranscriptResponse = z.infer<typeof zTranscriptResponse>;

// ── GET /api/v1/memory-sources ──

/** At most this many runs per memory pack: compaction happens on the user's machine, with the user's tokens. */
export const MEMORY_MAX_RUNS = 30;

export const zMemorySourcesQuery = z.object({
  /** Comma-separated run ids or run hashes. */
  runs: z.string().max(4000).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
  since: z.string().trim().min(4).max(40).optional(),
  until: z.string().trim().min(4).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(MEMORY_MAX_RUNS).default(MEMORY_MAX_RUNS),
}).refine((q) => q.runs || q.agent || q.since, { message: 'give runs, an agent, or a time range', path: ['runs'] });
export type MemorySourcesQuery = z.infer<typeof zMemorySourcesQuery>;

export const zMemorySource = z.object({
  run: zTranscriptRun,
  segments: z.array(zTranscriptSegment),
  page: zTranscriptPage.nullable(),
});
export type MemorySource = z.infer<typeof zMemorySource>;

/**
 * The scope resolved to runs, each with its segments and current note page.
 * The turns are NOT in here: a pack's worth of transcripts would blow past a
 * serverless response limit, so the client pulls each run's transcript
 * through the paginated endpoint and writes it to disk.
 */
export const zMemorySourcesResponse = z.object({
  scope: z.object({
    runs: z.array(z.string()).nullable(),
    agent: z.string().nullable(),
    since: z.string().nullable(),
    until: z.string().nullable(),
  }),
  sources: z.array(zMemorySource),
  /** True when the scope matched more runs than `limit`; the newest were kept. */
  truncated: z.boolean(),
});
export type MemorySourcesResponse = z.infer<typeof zMemorySourcesResponse>;

// ── memory packs (actario.memory/v1) ──

export const MEMORY_FORMAT = 'actario.memory/v1' as const;
export const zMemoryBudget = z.enum(['S', 'M', 'L']);
export type MemoryBudget = z.infer<typeof zMemoryBudget>;
/** Token ceilings (22.3 step 3). */
export const MEMORY_BUDGET_TOKENS: Record<MemoryBudget, number> = { S: 2000, M: 8000, L: 24000 };
/** The body can never be longer than this in characters, whatever the budget. */
export const MEMORY_BODY_MAX_CHARS = 200_000;

export const zMemoryScope = z.object({
  runs: z.array(z.string().min(1).max(200)).max(MEMORY_MAX_RUNS).optional(),
  agent: z.string().min(1).max(200).optional(),
  since: z.string().min(4).max(40).optional(),
  until: z.string().min(4).max(40).optional(),
}).strict();
export type MemoryScope = z.infer<typeof zMemoryScope>;

/** One anchor: a line of the pack points at a stretch of turns of a run. */
export const zMemoryAnchor = z.object({
  /** 1-based line of the body. */
  line: z.number().int().positive(),
  run_hash: z.string().min(8).max(200),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
}).refine((a) => a.to >= a.from, { message: 'the range ends before it starts', path: ['to'] });
export type MemoryAnchor = z.infer<typeof zMemoryAnchor>;

/** POST /api/v1/memory-packs: a new pack, or a new version of one of yours. */
export const zMemoryPackSave = z.object({
  /** Chosen by the client, so the local folder and the server row share one id. */
  pack_id: zUuid,
  /** The version this one replaces; 0 creates the pack. */
  base_version: z.number().int().nonnegative(),
  /** Defaults to the token's workspace. Must be one you belong to. */
  workspace_id: zUuid.optional(),
  title: z.string().trim().min(1).max(200),
  scope: zMemoryScope,
  as_of: zIso,
  budget: zMemoryBudget,
  body: z.string().min(1).max(MEMORY_BODY_MAX_CHARS),
  anchors: z.array(zMemoryAnchor).min(1).max(5000),
  client_prompt_version: z.string().max(80).nullable().default(null),
});
export type MemoryPackSave = z.infer<typeof zMemoryPackSave>;

export const zMemoryPackSaved = z.object({
  pack_id: zUuid,
  version: z.number().int().positive(),
  created: z.boolean(),
  unchanged: z.boolean().optional(),
});
export type MemoryPackSaved = z.infer<typeof zMemoryPackSaved>;

export const zMemoryPackMeta = z.object({
  id: zUuid,
  workspace_id: zUuid,
  title: z.string(),
  scope: zMemoryScope,
  current_version: z.number().int().positive(),
  created_at: zIso,
  updated_at: zIso,
});
export type MemoryPackMeta = z.infer<typeof zMemoryPackMeta>;

export const zMemoryPackVersion = z.object({
  version: z.number().int().positive(),
  as_of: zIso,
  budget: zMemoryBudget,
  body: z.string(),
  anchors: z.array(zMemoryAnchor),
  run_ids: z.array(zUuid),
  client_prompt_version: z.string().nullable(),
  created_at: zIso,
});
export type MemoryPackVersion = z.infer<typeof zMemoryPackVersion>;

export const zMemoryPackResponse = z.object({
  pack: zMemoryPackMeta,
  shown: zMemoryPackVersion,
  versions: z.array(z.object({ version: z.number().int(), as_of: zIso, budget: zMemoryBudget, created_at: zIso })),
});
export type MemoryPackResponse = z.infer<typeof zMemoryPackResponse>;

export const zMemoryPacksResponse = z.object({ packs: z.array(zMemoryPackMeta) });
export type MemoryPacksResponse = z.infer<typeof zMemoryPacksResponse>;

// ── run references ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a person may paste to name a run: its id, a web URL with the id in it
 * (`/runs/<id>`, `/runs/<id>/note`), or its run_hash (or a prefix of 12+ of
 * it -- the tables show 16). Pure; the caller looks it up.
 */
export function parseRunRef(input: string): { kind: 'id'; id: string } | { kind: 'hash'; hash: string } | null {
  const s = input.trim();
  if (!s) return null;
  if (UUID_RE.test(s)) return { kind: 'id', id: s.toLowerCase() };
  const url = /\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(s);
  if (url) return { kind: 'id', id: url[1]!.toLowerCase() };
  // A run_hash is a content hash, or `<adapter>:<run_ref>` when capture had none.
  if (/^[0-9a-f]{12,128}$/i.test(s)) return { kind: 'hash', hash: s.toLowerCase() };
  if (/^[a-z0-9_]+:[^\s]{1,180}$/i.test(s)) return { kind: 'hash', hash: s };
  return null;
}

/** Same id test the routes use, exported so the CLI agrees with them. */
export const isUuid = (s: string): boolean => UUID_RE.test(s);
