import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  actarioDir, bundleDirFor, findBundle, latestBundle, readBundleRuns, readConfig, readManifest, recordBundle,
  type BundleIndexEntry,
} from '@distill/capture';
import { RedactionEngine, ensureSalt } from '@distill/redaction';
import {
  CLIENT_PROMPT_VERSION, DAF_VERSION, lookupFromBundle, parseDaf, resolveDaf,
  type Daf, type DafValidationReport, type DroppedItem,
} from '@distill/daf';
import { readZip } from '@distill/export';
import { DistillError, type UploadStatusResponse } from '@distill/shared';
import type { UcfRun } from '@distill/ucf';
import { CLI_VERSION } from '../version.ts';
import { downloadExport, getUpload, submitAnalysis, type ApiOptions } from '../api.ts';

/**
 * The analysis flow, without a terminal (arch v1.3 §18.8).
 *
 * Shared by `actario analyze` and the MCP tools `list_runs`, `read_run` and
 * `submit_daf`. Same reasoning as core/capture.ts: the local pre-check runs
 * the same resolver the server does, in one place, so what the agent is told
 * before the round trip and what the server decides after it cannot disagree.
 *
 * No stdout, no process.exit. Endings are values.
 */

// ── which bundle ──

export type BundlePick =
  | { ok: true; entry: BundleIndexEntry }
  | { ok: false; reason: 'none_local' | 'ambiguous' | 'not_found_locally' | 'not_linked' | 'export_forbidden' };

/**
 * `wanted` is a bundle id, an upload id, or an unambiguous prefix of either.
 * Local first; a full upload id not on this machine is fetched back through
 * the export (unit 0001) -- the mechanism behind §18.7's "re-run for free".
 */
export async function pickBundle(
  wanted: string | undefined,
  api: ApiOptions | null,
  hooks: { onFetching?: (uploadId: string) => void } = {},
): Promise<BundlePick> {
  if (!wanted) {
    const latest = latestBundle();
    return latest ? { ok: true, entry: latest } : { ok: false, reason: 'none_local' };
  }
  const local = findBundle(wanted);
  if (local === 'ambiguous') return { ok: false, reason: 'ambiguous' };
  if (local && existsSync(bundleDirFor(local.bundle_id))) return { ok: true, entry: local };
  if (!/^[0-9a-f-]{36}$/i.test(wanted)) return { ok: false, reason: 'not_found_locally' };
  if (!api) return { ok: false, reason: 'not_linked' };
  hooks.onFetching?.(wanted);
  try {
    return { ok: true, entry: await restoreFromExport(api, wanted) };
  } catch (e) {
    if ((e as DistillError).code === 'forbidden') return { ok: false, reason: 'export_forbidden' };
    throw e;
  }
}

async function restoreFromExport(api: ApiOptions, uploadId: string): Promise<BundleIndexEntry> {
  const zip = readZip(await downloadExport(api, uploadId));
  const members = zip.filter((m) => m.name.startsWith('bundle/'));
  const manifest = members.find((m) => m.name === 'bundle/manifest.json');
  if (!manifest) throw new DistillError('internal', 'Export has no bundle/manifest.json', undefined, 502);
  const meta = JSON.parse(manifest.data().toString('utf8')) as { bundle_meta?: { bundle_id?: string; created_at?: string }; files?: unknown[] };
  const bundleId = meta.bundle_meta?.bundle_id;
  // A path segment and an index key, both from a server response: only a
  // UUID is accepted, so neither ".." nor a shape the index's schema rejects
  // (which would hide every local bundle) can get in.
  if (!bundleId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bundleId)) {
    throw new DistillError('internal', 'Export manifest has no usable bundle_id', undefined, 502);
  }
  const dir = bundleDirFor(bundleId);
  mkdirSync(join(dir, 'runs'), { recursive: true });
  let runsParts = 0;
  for (const m of members) {
    const rel = m.name.slice('bundle/'.length);
    if (rel.includes('..') || rel.startsWith('/')) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), m.data());
    if (rel.startsWith('runs/')) runsParts++;
  }
  if (runsParts === 0) {
    throw new DistillError('not_found', 'The export carried no bundle parts: retention has deleted this batch\'s raw runs', undefined, 404);
  }
  let runs = 0;
  for await (const r of readBundleRuns(dir)) if (r.ok) runs++;
  const entry: BundleIndexEntry = {
    bundle_id: bundleId, upload_id: uploadId, runs, origin: 'export',
    captured_at: meta.bundle_meta?.created_at ?? new Date().toISOString(),
  };
  recordBundle(entry);
  return entry;
}

// ── the runs, as the agent reads them ──

/**
 * The run's coordinate: what the capture pipeline hashed and what the server
 * deduplicates on. This -- not run_ref -- is what a DAF anchors to (v0.2).
 * Falls back exactly as fn:ingest does, so the two always agree.
 */
export const runHashOf = (run: UcfRun): string =>
  (run.raw_ext as { content_hash?: string }).content_hash ?? `${run.adapter_id}:${run.run_ref}`;

export interface RunIndexEntry {
  run_hash: string; run_ref: string; title: string | null; platform: string;
  turns: number; started_at: string | null; ended_at: string | null; agent_ref: string | null;
}

export interface ReadableRun {
  run_hash: string; run_ref: string; agent_ref: string | null; platform: string; model: string | null;
  title: string | null; started_at: string | null; ended_at: string | null; outcome: string | null;
  parse_level: string; turn_count: number;
  turns: { idx: number; role: string; timestamp: string | null; content: string; tool_calls?: unknown[]; tool_result?: string }[];
  artifacts: { path: string; change: string; diff_summary: string | null }[];
}

/** What the agent reads. Tool results are capped: they are evidence, not the conversation. */
export function readableRun(run: UcfRun): ReadableRun {
  return {
    run_hash: runHashOf(run),
    run_ref: run.run_ref,
    agent_ref: run.agent_ref,
    platform: run.platform,
    model: run.model,
    title: run.title,
    started_at: run.started_at,
    ended_at: run.ended_at,
    outcome: run.outcome,
    parse_level: run.parse_level,
    turn_count: run.turns.length,
    turns: run.turns.map((t) => ({
      idx: t.idx,
      role: t.role,
      timestamp: t.timestamp,
      content: t.content,
      ...(t.tool_calls && t.tool_calls.length > 0
        ? { tool_calls: t.tool_calls.map((c) => ({ name: c.name, ok: c.ok ?? null, params: summarizeParams(c.params) })) }
        : {}),
      ...(t.tool_result ? { tool_result: t.tool_result.length > 2000 ? `${t.tool_result.slice(0, 2000)}… [${t.tool_result.length} chars]` : t.tool_result } : {}),
    })),
    artifacts: run.artifacts.map((a) => ({ path: a.path, change: a.change, diff_summary: a.diff_summary })),
  };
}

function summarizeParams(p: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!p) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}… [${v.length} chars]` : v;
  }
  return out;
}

/** One table line for a run. The CLI's prepare() and `list_runs` both build their index from this. */
export const indexEntryOf = (run: UcfRun): RunIndexEntry => ({
  run_hash: runHashOf(run), run_ref: run.run_ref, title: run.title, platform: run.platform,
  turns: run.turns.length, started_at: run.started_at, ended_at: run.ended_at, agent_ref: run.agent_ref,
});

/** The batch as a table: one line per run, no content. This is what `list_runs` returns. */
export async function indexRuns(entry: BundleIndexEntry): Promise<{ runs: RunIndexEntry[]; unreadable: number }> {
  const runs: RunIndexEntry[] = [];
  let unreadable = 0;
  for await (const r of readBundleRuns(bundleDirFor(entry.bundle_id))) {
    if (!r.ok) { unreadable++; continue; }
    runs.push(indexEntryOf(r.run));
  }
  return { runs, unreadable };
}

/**
 * One run by its hash, or by an unambiguous prefix of it -- the table shows
 * 16 characters and an agent will type those back. Null when nothing matches;
 * 'ambiguous' when the prefix is too short.
 */
export async function findRun(entry: BundleIndexEntry, hashOrPrefix: string): Promise<ReadableRun | null | 'ambiguous'> {
  const needle = hashOrPrefix.toLowerCase();
  const hits: UcfRun[] = [];
  for await (const r of readBundleRuns(bundleDirFor(entry.bundle_id))) {
    if (r.ok && runHashOf(r.run).toLowerCase().startsWith(needle)) hits.push(r.run);
  }
  if (hits.length === 1) return readableRun(hits[0]!);
  if (hits.length === 0) return null;
  const exact = hits.find((r) => runHashOf(r).toLowerCase() === needle);
  return exact ? readableRun(exact) : 'ambiguous';
}

/** The DAF the agent starts from: bundle_id and analyzer already filled in. */
export async function dafTemplate(entry: BundleIndexEntry): Promise<Record<string, unknown>> {
  return {
    daf_version: DAF_VERSION,
    bundle_id: entry.bundle_id,
    analyzer: {
      kind: 'agent_session', model: null, skill_version: CLI_VERSION,
      prompt_version: CLIENT_PROMPT_VERSION, produced_at: new Date().toISOString(),
    },
    segments: [], entries: [], agent_states: [], pages: [],
  };
}

/**
 * C6 on the way out, for the text the agent wrote (design 0002).
 *
 * The bundle `read_run` serves is already redacted, and the skill writes from
 * it. But a segment summary or a note page is free text from a model that has
 * the raw conversation in its context too, and a page is long enough to carry
 * a pasted config block. So all of the analysis text crosses the same rules
 * the record did, on this machine, before it is sent -- with the same salt, so
 * a value the record already pseudonymised gets the same pseudonym here.
 * Mutates and returns the count.
 */
export function redactDafText(daf: Daf, engine: Pick<RedactionEngine, 'redactText'>): { hits: number; rules: Record<string, number> } {
  const rules: Record<string, number> = {};
  let hits = 0;
  const r = (t: string): string => {
    const out = engine.redactText(t);
    for (const h of out.hits) { hits++; rules[h.ruleId] = (rules[h.ruleId] ?? 0) + 1; }
    return out.text;
  };
  const rn = (t: string | null): string | null => (t == null ? t : r(t));
  for (const s of daf.segments) { s.topic = rn(s.topic); s.summary = rn(s.summary); s.labels = s.labels.map(r); }
  for (const e of daf.entries) {
    e.title = r(e.title); e.body = r(e.body);
    e.rejected_options = e.rejected_options.map(r); e.entities = e.entities.map(r);
  }
  for (const a of daf.agent_states) {
    a.doing_now = r(a.doing_now);
    if (a.last_action) a.last_action.summary = r(a.last_action.summary);
    a.blockers = a.blockers.map(r); a.recent_artifacts = a.recent_artifacts.map(r);
  }
  for (const p of daf.pages) {
    p.title = r(p.title); p.summary = rn(p.summary); p.labels = p.labels.map(r);
    for (const s of p.sections) { s.heading = r(s.heading); s.body = r(s.body); }
  }
  return { hits, rules };
}

function localEngine(): RedactionEngine {
  const cfg = readConfig();
  return new RedactionEngine({ profile: cfg.redaction_profile, salt: ensureSalt(actarioDir()), disabledRuleIds: cfg.disabled_redaction_rules });
}

export async function bundleCliVersion(entry: BundleIndexEntry): Promise<string> {
  return (await readManifest(bundleDirFor(entry.bundle_id))).bundle_meta.cli_version;
}

// ── submit ──

export type SubmitResult =
  | { kind: 'schema_invalid'; issues: { path: string; message: string }[] }
  | { kind: 'bundle_mismatch'; dafBundleId: string; selectedBundleId: string }
  /** Every item failed the local pre-check and `force` was not set. Nothing sent. */
  | { kind: 'all_dropped'; daf: Daf; drops: DroppedItem[] }
  | { kind: 'not_linked'; daf: Daf; drops: DroppedItem[] }
  | { kind: 'never_uploaded'; daf: Daf }
  | { kind: 'ingest_not_finished'; daf: Daf; uploadId: string }
  | { kind: 'refused'; daf: Daf; error: DistillError }
  | { kind: 'sent'; daf: Daf; drops: DroppedItem[]; uploadId: string; dafRef: string; queuedEntries: number; report: DafValidationReport | null;
      /** Values the local redaction pass replaced in the analysis text before sending. */
      redacted: { hits: number; rules: Record<string, number> } };

export interface SubmitOptions {
  /** Send even when every anchor fails the local check. */
  force?: boolean;
  /** Return as soon as the server has queued it, without waiting for the verdict. */
  noWait?: boolean;
  /** Tests inject one; the default reads this machine's profile and salt. */
  redactor?: Pick<RedactionEngine, 'redactText'>;
  onWaiting?: (status: string) => void;
}

/**
 * Validate locally, then upload and (unless told not to) wait for the verdict.
 *
 * `raw` may lack bundle_id: a DAF written from the template already has it, a
 * hand-written one may not, and the caller knows which bundle it means. This
 * is convenience, not trust -- the server checks the match regardless.
 */
export async function submitDaf(raw: unknown, entry: BundleIndexEntry, api: ApiOptions | null, opts: SubmitOptions = {}): Promise<SubmitResult> {
  if (raw && typeof raw === 'object' && !('bundle_id' in raw)) (raw as Record<string, unknown>).bundle_id = entry.bundle_id;

  const parsed = parseDaf(raw);
  if (!parsed.ok) return { kind: 'schema_invalid', issues: parsed.issues };
  const daf = parsed.daf;
  if (daf.bundle_id !== entry.bundle_id) return { kind: 'bundle_mismatch', dafBundleId: daf.bundle_id, selectedBundleId: entry.bundle_id };

  // Local pre-check: the resolver the server runs, over the local bundle.
  // Anything it drops here the server will drop too, in the same words.
  const runs: Parameters<typeof lookupFromBundle>[0] = [];
  for await (const r of readBundleRuns(bundleDirFor(entry.bundle_id))) {
    if (r.ok) runs.push({ run_hash: runHashOf(r.run), run_ref: r.run.run_ref, turns: r.run.turns.map((t) => ({ idx: t.idx })), started_at: r.run.started_at, ended_at: r.run.ended_at, agent_ref: r.run.agent_ref });
  }
  const local = await resolveDaf(daf, lookupFromBundle(runs));
  const drops = local.dropped.filter((d) =>
    d.reason === 'run_unresolved' || d.reason === 'anchor_unresolved' || d.reason === 'range_unresolved' || d.reason === 'invalid_field');

  const total = daf.entries.length + daf.segments.length + daf.agent_states.length + daf.pages.length;
  if (total > 0 && drops.length === total && !opts.force) return { kind: 'all_dropped', daf, drops };
  if (!api) return { kind: 'not_linked', daf, drops };
  if (!entry.upload_id) return { kind: 'never_uploaded', daf };

  // After every check that can refuse, before anything leaves the machine.
  const redacted = redactDafText(daf, opts.redactor ?? localEngine());
  // A pseudonym can be longer than what it replaced, so a field at its cap
  // can now be over it -- and the server would refuse the whole DAF. Say so
  // here instead, while the agent can still shorten it.
  if (redacted.hits > 0) {
    const again = parseDaf(daf);
    if (!again.ok) return { kind: 'schema_invalid', issues: again.issues.map((i) => ({ ...i, message: `${i.message} (after local redaction replaced ${redacted.hits} value(s); shorten this field)` })) };
  }

  // Ingest has to have finished, or the anchors point at rows that do not exist yet.
  if (!(await waitForIngest(api, entry.upload_id, opts.onWaiting))) return { kind: 'ingest_not_finished', daf, uploadId: entry.upload_id };

  let queued;
  try {
    queued = await submitAnalysis(api, entry.upload_id, JSON.stringify(daf));
  } catch (e) {
    return { kind: 'refused', daf, error: e instanceof DistillError ? e : new DistillError('internal', (e as Error).message) };
  }

  const report = opts.noWait ? null : await waitForVerdict(api, entry.upload_id, queued.daf_ref);
  return { kind: 'sent', daf, drops, uploadId: entry.upload_id, dafRef: queued.daf_ref, queuedEntries: queued.received.entries, report, redacted };
}

async function waitForIngest(api: ApiOptions, uploadId: string, onWaiting?: (status: string) => void, timeoutMs = 5 * 60_000): Promise<boolean> {
  const started = Date.now();
  let told = false;
  for (;;) {
    const u: UploadStatusResponse = await getUpload(api, uploadId);
    if (u.status === 'analyzing' || u.status === 'completed' || u.status === 'partial') return true;
    if (u.status === 'failed') return false;
    if (Date.now() - started > timeoutMs) return false;
    if (!told) { onWaiting?.(u.status); told = true; }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function waitForVerdict(api: ApiOptions, uploadId: string, dafRef: string, timeoutMs = 3 * 60_000): Promise<DafValidationReport | null> {
  const started = Date.now();
  for (;;) {
    const u = await getUpload(api, uploadId);
    const r = u.daf_validation_report as unknown as DafValidationReport | null;
    // The verdict names the DAF it is about; an older submission's report is
    // not an answer, however recent.
    if (r && r.daf_ref === dafRef) return r;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((res) => setTimeout(res, 2500));
  }
}

/** One line per dropped item, in the words the rubric uses. Shared by the CLI and the MCP tool. */
export function describeDrop(d: DroppedItem): string {
  const where = `${d.kind}[${d.index}]`;
  switch (d.reason) {
    case 'run_unresolved': return `${where}: run_hash ${(d.run_hash ?? '?').slice(0, 16)}… is not in this bundle`;
    case 'anchor_unresolved': return `${where}: turn idx ${d.detail?.join(', ')} not in run ${(d.run_hash ?? '?').slice(0, 16)}…`;
    case 'range_unresolved': return d.kind === 'page'
      ? `${where}: section range idx ${d.detail?.join(', ')} not in run ${(d.run_hash ?? '?').slice(0, 16)}… -- the whole page is dropped`
      : `${where}: segment range idx ${d.detail?.join(', ')} not in run ${(d.run_hash ?? '?').slice(0, 16)}…`;
    case 'agent_unresolved': return `${where}: none of its source runs is bound to an agent`;
    case 'agent_ambiguous': return `${where}: its source runs belong to different agents`;
    case 'over_cap': return d.kind === 'page' ? `${where}: a second page for the same run, or over the total cap` : `${where}: over the per-run or total cap`;
    case 'invalid_field': return d.kind === 'page'
      ? `${where}: the server could not store this page's text (an empty heading, or a character it cannot keep)`
      : `${where}: type is not one of the six, or confidence is outside 0..1`;
  }
}
