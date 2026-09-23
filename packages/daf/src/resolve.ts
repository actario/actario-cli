import { DAF_LIMITS as L } from './limits.ts';
import type { DroppedItem } from './report.ts';
import { isDafEntryType, type Daf, type DafAgentState, type DafEntry, type DafPage, type DafSegment } from './schema.ts';

/**
 * The validation gate, minus the database (arch v1.3 §18.5).
 *
 * This is deliberately a pure function over a lookup: the caller (fn:analyze)
 * supplies "what is run_hash X of this workspace, and what are its turns", and
 * this file decides what lands and what is dropped. That split is what lets
 * the rules of §18.5 -- each anchor must resolve, one bad anchor drops the
 * entry and never the batch, caps are per run and total -- be tested with
 * fixtures rather than a Postgres, and keeps the worker file to reading and
 * writing.
 *
 * Nothing here trusts the DAF. The `agent_ref` a client suggests is ignored in
 * favour of the agent the resolved runs are actually bound to (§18.2:
 * binding state is authoritative on the server, the client has no copy).
 *
 * Runs are addressed by content hash (v0.2; see schema.ts for why the run_ref
 * could not do the job). The lookup therefore cannot be ambiguous: the server
 * has `unique (workspace_id, content_hash)`, so a hash names at most one run,
 * and there is no case where the resolver has to choose.
 */

/** One run of the upload as the resolver sees it. */
export interface ResolvedRun {
  id: string;
  /** runs.content_hash -- the coordinate the DAF named. */
  run_hash: string;
  /** Informational, for the report: which session the run came from. */
  run_ref: string | null;
  agent_id: string | null;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  /** turn idx -> turns.id, for the whole run. */
  turnIds: ReadonlyMap<number, string>;
  /**
   * 'upload' -- found under this upload (the normal case)
   * 'workspace' -- the run belongs to an earlier upload of the same
   *                workspace. Routine after a re-capture: the batch was
   *                deduplicated at ingest (§7.3), so the rows the DAF is
   *                about are attached to the upload that first carried them
   */
  via: 'upload' | 'workspace';
}

export type RunLookup = (runHash: string) => Promise<ResolvedRun | null>;

export interface ResolvedSegment {
  index: number;
  run: ResolvedRun;
  seg: DafSegment;
}

export interface ResolvedEntry {
  index: number;
  run: ResolvedRun;
  entry: DafEntry;
  /** Server ids, in the DAF's anchor order. */
  turnIds: string[];
  /** Index into `segments` of the DAF segment that covers the first anchor, if any. */
  segmentIndex: number | null;
}

export interface ResolvedAgentState {
  index: number;
  agentId: string;
  runs: ResolvedRun[];
  state: DafAgentState;
}

export interface ResolvedPage {
  index: number;
  run: ResolvedRun;
  page: DafPage;
}

export interface DafResolution {
  segments: ResolvedSegment[];
  entries: ResolvedEntry[];
  agentStates: ResolvedAgentState[];
  pages: ResolvedPage[];
  dropped: DroppedItem[];
  runsResolvedViaWorkspace: string[];
}

export async function resolveDaf(daf: Daf, lookup: RunLookup): Promise<DafResolution> {
  const cache = new Map<string, ResolvedRun | null>();
  const run = async (hash: string): Promise<ResolvedRun | null> => {
    if (!cache.has(hash)) cache.set(hash, await lookup(hash));
    return cache.get(hash) ?? null;
  };

  const dropped: DroppedItem[] = [];
  const perRunSeg = new Map<string, number>();
  const perRunEnt = new Map<string, number>();

  // ── segments ──
  const segments: ResolvedSegment[] = [];
  for (const [index, seg] of daf.segments.entries()) {
    const r = await run(seg.run_hash);
    if (!r) { dropped.push({ kind: 'segment', index, run_hash: seg.run_hash, reason: 'run_unresolved' }); continue; }
    const bad = [seg.start_turn_idx, seg.end_turn_idx].filter((i) => !r.turnIds.has(i));
    if (bad.length > 0) { dropped.push({ kind: 'segment', index, run_hash: seg.run_hash, reason: 'range_unresolved', detail: bad }); continue; }
    const n = (perRunSeg.get(r.id) ?? 0) + 1;
    if (n > L.segmentsPerRun || segments.length >= L.segmentsTotal) {
      dropped.push({ kind: 'segment', index, run_hash: seg.run_hash, reason: 'over_cap' }); continue;
    }
    perRunSeg.set(r.id, n);
    segments.push({ index, run: r, seg });
  }

  // ── entries ──
  const entries: ResolvedEntry[] = [];
  for (const [index, entry] of daf.entries.entries()) {
    // Rule 6 first: it needs no lookup, and a bad type is a bad entry whatever
    // its anchors say.
    if (!isDafEntryType(entry.type) || !(entry.confidence >= 0 && entry.confidence <= 1)) {
      dropped.push({ kind: 'entry', index, run_hash: entry.run_hash, reason: 'invalid_field' }); continue;
    }
    const r = await run(entry.run_hash);
    if (!r) { dropped.push({ kind: 'entry', index, run_hash: entry.run_hash, reason: 'run_unresolved' }); continue; }
    // Rule 3 is strict on purpose: a claim whose citations are half real is
    // not half right, it is a claim with a fabricated citation attached.
    const bad = entry.source_turn_idx.filter((i) => !r.turnIds.has(i));
    if (bad.length > 0) { dropped.push({ kind: 'entry', index, run_hash: entry.run_hash, reason: 'anchor_unresolved', detail: bad }); continue; }
    const n = (perRunEnt.get(r.id) ?? 0) + 1;
    if (n > L.entriesPerRun || entries.length >= L.entriesTotal) {
      dropped.push({ kind: 'entry', index, run_hash: entry.run_hash, reason: 'over_cap' }); continue;
    }
    perRunEnt.set(r.id, n);
    const first = entry.source_turn_idx[0]!;
    const seg = segments.find((s) => s.run.id === r.id && s.seg.start_turn_idx <= first && first <= s.seg.end_turn_idx);
    entries.push({
      index, run: r, entry,
      turnIds: entry.source_turn_idx.map((i) => r.turnIds.get(i)!),
      segmentIndex: seg ? seg.index : null,
    });
  }

  // ── agent states ──
  const agentStates: ResolvedAgentState[] = [];
  for (const [index, state] of daf.agent_states.entries()) {
    const runs: ResolvedRun[] = [];
    let unresolved: string | null = null;
    for (const hash of state.source_run_hashes) {
      const r = await run(hash);
      if (!r) { unresolved = hash; break; }
      runs.push(r);
    }
    if (unresolved) { dropped.push({ kind: 'agent_state', index, run_hash: unresolved, reason: 'run_unresolved' }); continue; }
    const agents = [...new Set(runs.map((r) => r.agent_id).filter((a): a is string => !!a))];
    if (agents.length === 0) { dropped.push({ kind: 'agent_state', index, run_hash: null, reason: 'agent_unresolved' }); continue; }
    if (agents.length > 1) { dropped.push({ kind: 'agent_state', index, run_hash: null, reason: 'agent_ambiguous' }); continue; }
    if (agentStates.length >= L.agentStatesTotal) { dropped.push({ kind: 'agent_state', index, run_hash: null, reason: 'over_cap' }); continue; }
    agentStates.push({ index, agentId: agents[0]!, runs, state });
  }

  // ── note pages ──
  // Strict like entries: a page is one document, and a document whose
  // citations are partly invented is not partly right. The local pre-check
  // reports the bad indices before anything is sent, so the agent fixes the
  // range instead of losing the page.
  const pages: ResolvedPage[] = [];
  const perRunPage = new Map<string, number>();
  for (const [index, page] of (daf.pages ?? []).entries()) {
    const r = await run(page.run_hash);
    if (!r) { dropped.push({ kind: 'page', index, run_hash: page.run_hash, reason: 'run_unresolved' }); continue; }
    const bad = [...new Set(page.sections.flatMap((s) => [s.start_turn_idx, s.end_turn_idx]).filter((i) => !r.turnIds.has(i)))];
    if (bad.length > 0) { dropped.push({ kind: 'page', index, run_hash: page.run_hash, reason: 'range_unresolved', detail: bad }); continue; }
    const n = (perRunPage.get(r.id) ?? 0) + 1;
    if (n > L.pagesPerRun || pages.length >= L.pagesTotal) {
      dropped.push({ kind: 'page', index, run_hash: page.run_hash, reason: 'over_cap' }); continue;
    }
    perRunPage.set(r.id, n);
    pages.push({ index, run: r, page });
  }

  const runsResolvedViaWorkspace = [...cache.values()]
    .filter((r): r is ResolvedRun => !!r && r.via === 'workspace')
    .map((r) => r.run_hash);

  return { segments, entries, agentStates, pages, dropped, runsResolvedViaWorkspace };
}

/** Coverage end of a state card: the latest moment any of its source runs reaches. */
export function coverageEnd(runs: ResolvedRun[]): string {
  // By instant, not by string: UCF timestamps carry whatever offset the
  // source wrote, and "+08:00" sorts after "Z" lexically whatever the time.
  return runs.map((r) => r.ended_at ?? r.started_at).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
}

/**
 * Client-side pre-check for `actario analyze --daf`, against the local
 * bundle rather than the database. Same rules, same reasons, so what the CLI
 * warns about is exactly what the server would drop -- minus the dedupe
 * fallback, which only the server can know about.
 */
export function lookupFromBundle(
  runs: { run_hash: string; run_ref: string | null; turns: { idx: number }[]; started_at: string | null; ended_at: string | null; agent_ref: string | null }[],
): RunLookup {
  const byHash = new Map(runs.map((r) => [r.run_hash, r]));
  return async (hash) => {
    const r = byHash.get(hash);
    if (!r) return null;
    return {
      id: r.run_hash, run_hash: r.run_hash, run_ref: r.run_ref,
      // The bundle has no server agent ids; the agent_ref stands in so that
      // "all source runs share one agent" is still checkable locally.
      agent_id: r.agent_ref, project_id: null,
      started_at: r.started_at ?? '1970-01-01T00:00:00Z', ended_at: r.ended_at,
      turnIds: new Map(r.turns.map((t) => [t.idx, `${r.run_hash}#${t.idx}`])),
      via: 'upload',
    };
  };
}
