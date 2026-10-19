import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { allAdapters } from '@distill/adapters';
import {
  actarioDir, commitHighWaterMark, keepBundle, localEnv, packBundle, readBundleRuns, readConfig, readManifest,
  readState, runCapture, score, type CaptureOutcome,
} from '@distill/capture';
import { ensureSalt, writeEncrypted } from '@distill/redaction';
import { DistillError, uuid, type BundleMeta } from '@distill/shared';
import type { UcfAgent, UcfRun } from '@distill/ucf';
import { pushBundle } from '../api.ts';
import { CLI_VERSION } from '../version.ts';
import { resolveLink } from './capture.ts';
import { readableRun, runHashOf, type ReadableRun } from './analyze.ts';

/**
 * End of the day (skill `acta-bye`, 2026-10-19): look first, upload after.
 *
 * `capture` scans, redacts, packs and uploads in one go -- right for "save
 * this conversation", wrong for "here is everything I did today, which of it
 * goes up?". This file splits that sequence at the one place a person has to
 * be asked:
 *
 *   stageSessions   scan + redact + pack into ~/.actario/staged/<id>/ --
 *                   nothing leaves the machine, no high-water mark moves;
 *   readStaged      one staged run, brief (to write a one-line summary) or full;
 *   uploadStaged    the runs the person picked, repacked as a bundle of their
 *                   own and pushed exactly like `capture` pushes; the rest
 *                   stay here, and the ones they said no to are remembered;
 *   upload rules    per line: `auto` (upload without asking) or `review`.
 *                   No global switch: a line nobody has set is reviewed, and
 *                   a run with no line is always reviewed (there is nothing
 *                   to attach the rule to).
 *
 * Redaction is the capture pipeline's, unchanged (`runCapture`): a staged run
 * is already the redacted run that would be uploaded, so what the person
 * reviews is what the server gets (C6).
 */

// ── upload rules, per line ──────────────────────────────────────────────

export const UPLOAD_MODES = ['auto', 'review'] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

const zLineRule = z.object({
  mode: z.enum(UPLOAD_MODES),
  /** The line's display name when the rule was set, for listing it back. */
  name: z.string().max(300).nullable().default(null),
  updated_at: z.string(),
});
const zByeSettings = z.object({
  version: z.literal(1).default(1),
  /** Keyed by lineKey(agent_ref). */
  lines: z.record(z.string(), zLineRule).default({}),
  /** run hashes the person said no to; a later scan marks them instead of offering them again. */
  skipped: z.array(z.string()).default([]),
});
export type ByeSettings = z.infer<typeof zByeSettings>;

const SKIPPED_CAP = 5_000;
const settingsPath = () => join(actarioDir(), 'bye.json');

export function readByeSettings(): ByeSettings {
  const p = settingsPath();
  if (!existsSync(p)) return zByeSettings.parse({});
  try { return zByeSettings.parse(JSON.parse(readFileSync(p, 'utf8'))); } catch { return zByeSettings.parse({}); }
}

function writeByeSettings(s: ByeSettings): void {
  mkdirSync(actarioDir(), { recursive: true });
  const tmp = `${settingsPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, settingsPath());
}

/**
 * A line is the agent a run binds to, and the agent_ref is what binds it: a
 * repo path (Claude Code, or a record with repo_path) or a project name (a
 * record with project). Paths on Windows are case-insensitive and come with
 * either slash; project names are not paths and stay exactly as written,
 * because the server tells `Distill` and `distill` apart.
 */
export function lineKey(agentRef: string, platform: NodeJS.Platform = process.platform): string {
  const looksLikePath = /[\\/]/.test(agentRef) || /^[A-Za-z]:/.test(agentRef);
  if (!looksLikePath) return agentRef;
  const p = agentRef.replace(/[\\/]+$/, '');
  return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

export interface LineRuleView { line: string; name: string | null; mode: UploadMode; updated_at: string }

export function listLineRules(s = readByeSettings()): LineRuleView[] {
  return Object.entries(s.lines)
    .map(([line, r]) => ({ line, name: r.name, mode: r.mode, updated_at: r.updated_at }))
    .sort((a, b) => (a.name ?? a.line).localeCompare(b.name ?? b.line));
}

/**
 * Sets rules by line. `line` is the `line.ref` a scan returned, or a line's
 * name as a scan or an earlier rule showed it; a name that matches more
 * than one line is refused with the candidates.
 */
export function setLineRules(changes: { line: string; mode: UploadMode }[], now = new Date()): LineRuleView[] {
  const s = readByeSettings();
  const known = knownLines(s);
  for (const c of changes) {
    const target = resolveLine(c.line, known);
    s.lines[target.key] = { mode: c.mode, name: target.name, updated_at: now.toISOString() };
  }
  writeByeSettings(s);
  return listLineRules(s);
}

interface KnownLine { key: string; name: string | null }

/** Lines this machine has seen: those with a rule, and those in the staged batches still kept. */
function knownLines(s: ByeSettings): KnownLine[] {
  const m = new Map<string, string | null>();
  for (const [key, r] of Object.entries(s.lines)) m.set(key, r.name);
  for (const st of listStages()) {
    for (const r of st.runs) if (r.line) m.set(lineKey(r.line.ref), m.get(lineKey(r.line.ref)) ?? r.line.name);
  }
  return [...m].map(([key, name]) => ({ key, name }));
}

function resolveLine(wanted: string, known: KnownLine[]): KnownLine {
  const byKey = known.find((k) => k.key === lineKey(wanted));
  if (byKey) return byKey;
  const w = wanted.trim().toLowerCase();
  const byName = known.filter((k) => k.name?.toLowerCase() === w);
  if (byName.length === 1) return byName[0]!;
  const loose = byName.length === 0 ? known.filter((k) => k.name?.toLowerCase().includes(w)) : byName;
  if (loose.length === 1) return loose[0]!;
  const list = known.map((k) => `${k.name ?? '(unnamed)'} = ${k.key}`).join('; ') || 'none yet -- run stage_sessions first';
  if (loose.length === 0) {
    throw new DistillError('not_found', `No line on this machine matches "${wanted}". Known lines: ${list}.`);
  }
  throw new DistillError('invalid_request', `"${wanted}" matches more than one line; pass its ref instead. Known lines: ${list}.`);
}

// ── staged batches ──────────────────────────────────────────────────────

const KEEP_STAGES = 5;
const stagesDir = () => join(actarioDir(), 'staged');
const stageDir = (id: string) => join(stagesDir(), id);

export interface StagedRun {
  run_hash: string;
  /** adapter id@version, for the high-water ledger on upload. */
  adapter_key: string;
  platform: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
  turns: number;
  user_turns: number;
  line: { ref: string; name: string } | null;
  /** First and last thing the person asked, redacted, cut to a line or two. */
  first_ask: string | null;
  last_ask: string | null;
  files_changed: string[];
  files_changed_total: number;
  /** The record this scan was given: the conversation the scan was run from. */
  current: boolean;
}

interface StageMeta {
  version: 1;
  stage_id: string;
  created_at: string;
  since: string;
  bundle_dir: string;
  runs: StagedRun[];
  uploads: { upload_id: string; bundle_id: string; run_hashes: string[]; at: string }[];
}

export interface ReviewRun extends StagedRun {
  /** What the line's rule says. A run with no line, or a line with no rule, is `review`. */
  policy: UploadMode;
  /** The line has no rule yet (first time this machine sees it, or never set). */
  new_line: boolean;
  /** The person said no to exactly this content before. */
  skipped_before: boolean;
  uploaded: boolean;
}

function writeStage(meta: StageMeta): void {
  const tmp = join(stageDir(meta.stage_id), 'stage.json.tmp');
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(stageDir(meta.stage_id), 'stage.json'));
}

function listStages(): StageMeta[] {
  if (!existsSync(stagesDir())) return [];
  const out: StageMeta[] = [];
  for (const id of readdirSync(stagesDir())) {
    const p = join(stageDir(id), 'stage.json');
    if (!existsSync(p)) continue;
    try { out.push(JSON.parse(readFileSync(p, 'utf8')) as StageMeta); } catch { /* a broken stage is skipped, not fatal */ }
  }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function pruneStages(): void {
  const all = listStages();
  for (const gone of all.slice(KEEP_STAGES)) rmSync(stageDir(gone.stage_id), { recursive: true, force: true });
  // Directories a crashed scan left without a stage.json.
  if (!existsSync(stagesDir())) return;
  const kept = new Set(all.slice(0, KEEP_STAGES).map((s) => s.stage_id));
  for (const id of readdirSync(stagesDir())) if (!kept.has(id)) rmSync(stageDir(id), { recursive: true, force: true });
}

/** A stage by id, unambiguous prefix, or "latest". */
export function findStage(idOrPrefix?: string): StageMeta {
  const all = listStages();
  if (!idOrPrefix || idOrPrefix === 'latest') {
    if (!all[0]) throw new DistillError('not_found', 'Nothing staged on this machine. Call stage_sessions first.');
    return all[0];
  }
  const hits = all.filter((s) => s.stage_id.startsWith(idOrPrefix.toLowerCase()));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new DistillError('not_found', `No staged batch matches ${idOrPrefix}. Staged batches are kept for the last ${KEEP_STAGES} scans.`);
  throw new DistillError('invalid_request', `More than one staged batch starts with ${idOrPrefix}; give more of the id.`);
}

export function reviewView(meta: StageMeta, s = readByeSettings()): ReviewRun[] {
  const skipped = new Set(s.skipped);
  const uploaded = new Set(meta.uploads.flatMap((u) => u.run_hashes));
  return meta.runs.map((r) => {
    const rule = r.line ? s.lines[lineKey(r.line.ref)] : undefined;
    return {
      ...r,
      policy: rule?.mode ?? 'review',
      new_line: !!r.line && !rule,
      skipped_before: skipped.has(r.run_hash),
      uploaded: uploaded.has(r.run_hash),
    };
  });
}

/** Local midnight: "today" is the person's day, not UTC's. */
export function startOfLocalDay(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Bulk exports (a conversations.json in Downloads) are not "today's sessions". */
const isExportAdapter = (id: string) => /_export$/.test(id);

export type StageResult =
  | { kind: 'nothing_new'; since: string; already_uploaded: number; adapters: string[] }
  | { kind: 'rejected'; outcome: CaptureOutcome }
  | { kind: 'staged'; meta: StageMeta; outcome: CaptureOutcome };

export interface StageOptions {
  since?: Date;
  /** Adapter ids; default every installed adapter except bulk-export ones. */
  sources?: string[];
  /** The path of the record written for the conversation the scan runs from, if any. */
  recordPath?: string | null;
}

export async function stageSessions(opts: StageOptions = {}): Promise<StageResult> {
  const cfg = readConfig();
  const dir = actarioDir();
  const salt = ensureSalt(dir);
  const adapters = await allAdapters(join(dir, 'adapters'));
  const since = opts.since ?? startOfLocalDay();
  const sources = opts.sources && opts.sources.length > 0
    ? opts.sources
    : [...new Set(adapters.map((a) => a.id))].filter((id) => !isExportAdapter(id));

  const stageId = uuid();
  mkdirSync(stageDir(stageId), { recursive: true });

  let outcome: CaptureOutcome;
  try {
    outcome = await runCapture({
      env: localEnv(cfg.extra_paths),
      adapters,
      state: readState(),
      outDir: stageDir(stageId),
      cliVersion: CLI_VERSION,
      profile: cfg.redaction_profile,
      uploadDiffs: cfg.upload_diffs,
      salt,
      since,
      sources,
      allowSoft: true,
      disabledRuleIds: cfg.disabled_redaction_rules,
      customTerms: cfg.redaction_terms,
      conversationNamespace: cfg.identity?.workspace_id ?? null,
    });
  } catch (e) {
    rmSync(stageDir(stageId), { recursive: true, force: true });
    throw e;
  }

  // Same as capture: the map never leaves the machine, and is written even
  // when nothing is uploaded, so the next attempt pseudonymises the same way.
  if (outcome.redactionMap.entries.length > 0) {
    writeEncrypted(join(dir, 'redaction_map.json.enc'), salt, outcome.redactionMap);
  }

  if (outcome.report.runs_total === 0 || !outcome.pack) {
    rmSync(stageDir(stageId), { recursive: true, force: true });
    if (outcome.verdict === 'reject' && outcome.report.runs_total > 0) return { kind: 'rejected', outcome };
    return { kind: 'nothing_new', since: since.toISOString(), already_uploaded: outcome.skippedDuplicates, adapters: outcome.report.adapters.map((a) => a.adapter_id) };
  }
  if (outcome.verdict === 'reject') {
    rmSync(stageDir(stageId), { recursive: true, force: true });
    return { kind: 'rejected', outcome };
  }

  const keyOf = new Map<string, string>();
  for (const [key, hashes] of Object.entries(outcome.hashesByAdapter)) for (const h of hashes) keyOf.set(h, key);
  const agents = new Map(outcome.agents.map((a) => [a.agent_ref, a]));
  const recordFile = opts.recordPath ? basename(opts.recordPath) : null;

  const meta: StageMeta = {
    version: 1,
    stage_id: stageId,
    created_at: new Date().toISOString(),
    since: since.toISOString(),
    bundle_dir: basename(outcome.pack.bundleDir),
    runs: outcome.runs
      .map((run) => stagedRunOf(run, keyOf.get(runHashOf(run)) ?? `${run.adapter_id}@${run.adapter_version}`, agents, recordFile))
      .sort((a, b) => ((a.ended_at ?? a.started_at ?? '') < (b.ended_at ?? b.started_at ?? '') ? 1 : -1)),
    uploads: [],
  };
  writeStage(meta);
  pruneStages();
  return { kind: 'staged', meta, outcome };
}

const ONE_LINE = 240;
const cut = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * What the person typed, not what the client wrapped around it: Claude Code
 * stores slash commands, hook output and interruptions as user turns that
 * open with a tag. Those are skipped when there is a real ask to show.
 */
function asks(run: UcfRun): string[] {
  const user = run.turns.filter((t) => t.role === 'user' && t.content.trim().length > 0 && !t.tool_result);
  const real = user.filter((t) => !t.content.trim().startsWith('<'));
  return (real.length > 0 ? real : user).map((t) => t.content);
}

function stagedRunOf(run: UcfRun, adapterKey: string, agents: Map<string, UcfAgent>, recordFile: string | null): StagedRun {
  const a = asks(run);
  const changed = [...new Set(run.artifacts.map((x) => x.path))];
  const agent = run.agent_ref ? agents.get(run.agent_ref) : undefined;
  return {
    run_hash: runHashOf(run),
    adapter_key: adapterKey,
    platform: run.platform,
    title: run.title,
    started_at: run.started_at,
    ended_at: run.ended_at,
    outcome: run.outcome,
    turns: run.turns.length,
    user_turns: a.length,
    line: run.agent_ref ? { ref: run.agent_ref, name: agent?.name ?? run.agent_ref.split(/[\\/]/).pop() ?? run.agent_ref } : null,
    first_ask: a[0] ? cut(a[0], ONE_LINE) : null,
    last_ask: a.length > 1 ? cut(a[a.length - 1]!, ONE_LINE) : null,
    files_changed: changed.slice(0, 8),
    files_changed_total: changed.length,
    current: !!recordFile && (run.raw_ext as { source_file?: string }).source_file === recordFile,
  };
}

async function stagedRuns(meta: StageMeta): Promise<UcfRun[]> {
  const out: UcfRun[] = [];
  for await (const r of readBundleRuns(join(stageDir(meta.stage_id), meta.bundle_dir))) if (r.ok) out.push(r.run);
  return out;
}

function pickHash(meta: StageMeta, hashOrPrefix: string): string {
  const needle = hashOrPrefix.toLowerCase();
  const hits = meta.runs.filter((r) => r.run_hash.toLowerCase().startsWith(needle));
  if (hits.length === 1) return hits[0]!.run_hash;
  const exact = hits.find((r) => r.run_hash.toLowerCase() === needle);
  if (exact) return exact.run_hash;
  if (hits.length === 0) throw new DistillError('not_found', `No staged run in ${meta.stage_id.slice(0, 8)} starts with ${hashOrPrefix}.`);
  throw new DistillError('invalid_request', `More than one staged run starts with ${hashOrPrefix}; give more of the hash.`);
}

export interface BriefRun {
  run_hash: string; platform: string; title: string | null; started_at: string | null; ended_at: string | null; turn_count: number;
  turns: { idx: number; role: string; content: string }[];
  files_changed: string[];
}

const BRIEF_USER = 1_500;
const BRIEF_ASSISTANT = 600;

/**
 * `brief`: enough to say in a line what a session did and where it stopped
 * -- every turn's text, cut short, no tool calls or results. A day of Claude
 * Code sessions read in full would not fit one context; the note page is
 * written later, from read_run, only for the runs that go up.
 */
export async function readStaged(stage: string | undefined, hashOrPrefix: string, view: 'brief' | 'full' = 'brief'): Promise<ReadableRun | BriefRun> {
  const meta = findStage(stage);
  const hash = pickHash(meta, hashOrPrefix);
  const run = (await stagedRuns(meta)).find((r) => runHashOf(r) === hash);
  if (!run) throw new DistillError('not_found', `Run ${hash.slice(0, 12)} is listed but could not be read from the staged batch.`);
  if (view === 'full') return readableRun(run);
  return {
    run_hash: hash, platform: run.platform, title: run.title, started_at: run.started_at, ended_at: run.ended_at, turn_count: run.turns.length,
    turns: run.turns
      .filter((t) => t.content.trim().length > 0)
      .map((t) => ({ idx: t.idx, role: t.role, content: cut(t.content, t.role === 'user' ? BRIEF_USER : BRIEF_ASSISTANT) })),
    files_changed: [...new Set(run.artifacts.map((x) => x.path))],
  };
}

export type UploadResult =
  | { kind: 'not_linked' }
  | { kind: 'rejected'; cqs: number; remediation: string[] }
  | { kind: 'upload_failed'; error: DistillError }
  | { kind: 'uploaded'; uploadId: string; bundleId: string; runs: StagedRun[]; skipped: string[]; keptAt: string | null };

/**
 * Uploads the chosen runs of a staged batch as a bundle of their own, the way
 * `capture` uploads: push, then -- only after the server confirmed -- the
 * content hashes into the ledger and the bundle into the local store, so
 * list_runs / read_run / submit_daf work on it at once.
 *
 * The high-water mark does NOT move. Moving it would hide the runs the person
 * left for later from every future scan; the hash ledger alone keeps what
 * went up from going up twice.
 */
export async function uploadStaged(stage: string | undefined, upload: string[], skip: string[] = [], apiUrl?: string): Promise<UploadResult> {
  const meta = findStage(stage);
  const want = new Set(upload.map((h) => pickHash(meta, h)));
  const skipHashes = skip.map((h) => pickHash(meta, h)).filter((h) => !want.has(h));

  const rememberSkips = () => {
    if (skipHashes.length === 0) return;
    const s = readByeSettings();
    s.skipped = [...new Set([...s.skipped, ...skipHashes])].slice(-SKIPPED_CAP);
    writeByeSettings(s);
  };

  if (want.size === 0) {
    rememberSkips();
    return { kind: 'uploaded', uploadId: '', bundleId: '', runs: [], skipped: skipHashes, keptAt: null };
  }

  const cfg = readConfig();
  const link = resolveLink(cfg, apiUrl);
  if (!link) return { kind: 'not_linked' };

  const bundleDir = join(stageDir(meta.stage_id), meta.bundle_dir);
  const manifest = await readManifest(bundleDir);
  const runs = (await stagedRuns(meta)).filter((r) => want.has(runHashOf(r)));
  const refs = new Set(runs.map((r) => r.agent_ref).filter((x): x is string => !!x));
  const allAgents = JSON.parse(await readFile(join(bundleDir, 'agents.json'), 'utf8')) as { agents: UcfAgent[] };
  const agents = allAgents.agents.filter((a) => refs.has(a.agent_ref));

  const ids = new Set(runs.map((r) => r.adapter_id));
  const scored = score({
    runs,
    dropped: [],
    adapters: manifest.capture_report.adapters
      .filter((a) => ids.has(a.adapter_id))
      .map((a) => ({ ...a, runs: runs.filter((r) => r.adapter_id === a.adapter_id).length })),
    // Counted over the whole staged batch: redaction is not tracked per run.
    redactions: manifest.capture_report.redactions,
    profile: manifest.bundle_meta.redaction_profile,
  });
  if (scored.verdict === 'reject') return { kind: 'rejected', cqs: scored.report.cqs, remediation: scored.remediation };

  const bundleMeta: BundleMeta = { ...manifest.bundle_meta, bundle_id: uuid(), created_at: new Date().toISOString(), cli_version: CLI_VERSION };
  const pack = await packBundle({
    outDir: await mkdtemp(join(tmpdir(), 'actario-bundle-')),
    bundleMeta, captureReport: scored.report, agents, runs, droppedRuns: [],
  });

  let push;
  try {
    push = await pushBundle({ baseUrl: link.apiUrl, token: link.token }, {
      sourceId: link.sourceId, bundleDir: pack.bundleDir, bundleMeta, captureReport: scored.report, files: pack.files,
    });
  } catch (e) {
    return { kind: 'upload_failed', error: e instanceof DistillError ? e : new DistillError('internal', (e as Error).message) };
  }

  const picked = meta.runs.filter((r) => want.has(r.run_hash));
  const byKey = new Map<string, string[]>();
  for (const r of picked) byKey.set(r.adapter_key, [...(byKey.get(r.adapter_key) ?? []), r.run_hash]);
  for (const [key, hashes] of byKey) commitHighWaterMark(key, null, hashes, push.uploadId);

  let keptAt: string | null = null;
  try { keptAt = keepBundle(pack.bundleDir, { bundle_id: bundleMeta.bundle_id, upload_id: push.uploadId, runs: runs.length }); } catch { /* analysis can fetch it back */ }

  meta.uploads.push({ upload_id: push.uploadId, bundle_id: bundleMeta.bundle_id, run_hashes: [...want], at: new Date().toISOString() });
  writeStage(meta);
  rememberSkips();

  return { kind: 'uploaded', uploadId: push.uploadId, bundleId: bundleMeta.bundle_id, runs: picked, skipped: skipHashes, keptAt };
}
