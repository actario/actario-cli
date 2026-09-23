import type { ZipEntry } from './zip.ts';

/**
 * Per-upload export, `distill.export/v1` (design unit 0001).
 *
 * This module knows nothing about Supabase: the caller hands it a data source
 * and gets back the zip entries. That keeps the archive layout testable with
 * fixtures, and lets a later whole-workspace export (arch 11.3,
 * GET /api/v1/export) reuse it by iterating uploads.
 *
 * Two copies of the conversation go in, on purpose. The raw UCF bundle sits in
 * a transient bucket and is deleted by retention; `turns.content` is cleared
 * by the same sweep. At any given moment one of the two may be gone, and an
 * export that carries both is the only one that is self-sufficient at every
 * point in the upload's life. A missing Storage object is recorded in
 * export.json, never thrown: the export is a snapshot of what exists.
 */

export const EXPORT_FORMAT = 'distill.export/v1' as const;

export type Json = Record<string, unknown>;

export interface ExportUpload {
  id: string;
  workspace_id: string;
  source_id: string;
  bundle_ref: string;
  status: string;
  quality_score: number | null;
  cqs_version: string | null;
  created_at: string;
  /** uploads.manifest as stored: `{ files: [...], bundle_meta: {...} }`. */
  manifest: { files: { name: string; bytes: number; sha256: string }[]; bundle_meta?: Json };
  capture_report: Json | null;
  dropped_runs: unknown[];
  runs_ingested: number | null;
}

export interface ExportRecord {
  analysis_run_id: string;
  record_hash: string;
  input_hash: string;
  created_at: string;
  json: Uint8Array | null;
  md: Uint8Array | null;
}

/** What the composer needs from whoever owns the data. Every read is the caller's RLS. */
export interface ExportSource {
  upload: ExportUpload;
  /** Bytes of `bundles/<bundle_ref>/<name>`; null when the object is gone. */
  bundleFile(name: string): Promise<Uint8Array | AsyncIterable<Uint8Array> | null>;
  runs(): Promise<Json[]>;
  turns(runIds: string[]): Promise<Json[]>;
  artifacts(runIds: string[]): Promise<Json[]>;
  /** entries joined with their entry_sources (as `sources: [{turn_id, ord}]`). */
  entries(runIds: string[]): Promise<Json[]>;
  agents(agentIds: string[]): Promise<Json[]>;
  records(): Promise<ExportRecord[]>;
}

export interface ExportMeta {
  format: typeof EXPORT_FORMAT;
  exported_at: string;
  exported_by: string;
  /** Always true: the server holds pseudonyms only. `actario unmask` is the local step. */
  pseudonymized: true;
  upload: Omit<ExportUpload, 'manifest' | 'capture_report'>;
  counts: {
    bundle_files: number;
    runs: number;
    turns: number;
    artifacts: number;
    entries: number;
    agents: number;
    records: number;
  };
  /** Bundle members declared in the manifest that Storage no longer has. */
  missing: { name: string; reason: 'not_found' | 'unsafe_name' }[];
  bytes: { bundle: number };
}

const enc = new TextEncoder();
const jsonl = (rows: Json[]): Uint8Array => enc.encode(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const json = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);

const uniq = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

/** Bundle members are user-declared names; the manifest schema already restricts them, this is the belt to that brace. */
const safeMember = (name: string): boolean =>
  /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.split('/').includes('..');

export interface ComposeOptions {
  exportedBy: string;
  now?: () => Date;
}

/**
 * Yields the archive's entries in order. `export.json` comes LAST: its counts
 * and its missing-file list are only known once everything else has been
 * pulled, and buffering the bundle to write it first would defeat streaming.
 * Readers find members through the central directory, so order is cosmetic.
 */
export async function* composeUploadExport(
  src: ExportSource,
  opts: ComposeOptions,
): AsyncGenerator<ZipEntry> {
  const now = (opts.now ?? (() => new Date()))();
  const u = src.upload;
  const mtime = new Date(u.created_at);

  // ── DB copy first: small, and the run ids drive everything else ──
  const runs = await src.runs();
  const runIds = uniq(runs.map((r) => r.id as string));
  const [turns, artifacts, entries] = await Promise.all([
    runIds.length ? src.turns(runIds) : Promise.resolve([]),
    runIds.length ? src.artifacts(runIds) : Promise.resolve([]),
    runIds.length ? src.entries(runIds) : Promise.resolve([]),
  ]);
  const agentIds = uniq([
    ...runs.map((r) => r.agent_id as string | null),
    ...entries.map((e) => e.agent_id as string | null),
  ]);
  const agents = agentIds.length ? await src.agents(agentIds) : [];

  yield { name: 'db/runs.jsonl', data: jsonl(runs), mtime };
  yield { name: 'db/turns.jsonl', data: jsonl(turns), mtime };
  yield { name: 'db/artifacts.jsonl', data: jsonl(artifacts), mtime };
  yield { name: 'db/entries.jsonl', data: jsonl(entries), mtime };
  yield { name: 'db/agents.json', data: json(agents), mtime };

  // ── raw bundle, as declared at init; manifest.json itself is not in files[] ──
  yield { name: 'bundle/manifest.json', data: json(u.manifest), mtime };
  const missing: ExportMeta['missing'] = [];
  let bundleBytes = 0;
  let bundleFiles = 0;
  for (const f of u.manifest.files) {
    if (!safeMember(f.name)) { missing.push({ name: f.name, reason: 'unsafe_name' }); continue; }
    const data = await src.bundleFile(f.name);
    if (data === null) { missing.push({ name: f.name, reason: 'not_found' }); continue; }
    bundleFiles += 1;
    // Count as we stream so export.json can report the size without a second pass.
    const counted = data instanceof Uint8Array
      ? (bundleBytes += data.length, data)
      : (async function* () { for await (const c of data) { bundleBytes += c.length; yield c; } })();
    yield { name: `bundle/${f.name}`, data: counted, mtime };
  }

  // ── Record Files, if the analysis has produced any ──
  const records = await src.records();
  for (const r of records) {
    if (r.json) yield { name: `records/${r.analysis_run_id}.record.json`, data: r.json, mtime: new Date(r.created_at) };
    if (r.md) yield { name: `records/${r.analysis_run_id}.record.md`, data: r.md, mtime: new Date(r.created_at) };
  }

  const { manifest: _m, capture_report: _c, ...uploadMeta } = u;
  void _m; void _c;
  const meta: ExportMeta = {
    format: EXPORT_FORMAT,
    exported_at: now.toISOString(),
    exported_by: opts.exportedBy,
    pseudonymized: true,
    upload: uploadMeta,
    counts: {
      bundle_files: bundleFiles,
      runs: runs.length,
      turns: turns.length,
      artifacts: artifacts.length,
      entries: entries.length,
      agents: agents.length,
      records: records.length,
    },
    missing,
    bytes: { bundle: bundleBytes },
  };
  yield { name: 'export.json', data: json(meta), mtime: now };
}

export const exportFileName = (uploadId: string): string => `actario-export-${uploadId}.zip`;
