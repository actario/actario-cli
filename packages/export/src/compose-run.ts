import { createGunzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { EXPORT_FORMAT, type Json } from './compose.ts';
import type { ZipEntry } from './zip.ts';

/**
 * Per-session export (Jacky, 2026-10-24; migration 20261024000100).
 *
 * The export moved from the Uploads page to the Sessions page, so its unit is
 * now one session (run), not one upload. Two things make that more than a
 * filter on the per-upload archive:
 *
 *   - an upload can carry several sessions, so the raw bundle parts cannot go
 *     in whole: only this session's lines are kept;
 *   - one session can be spread over several uploads -- a later capture of
 *     the same conversation joins it as a new version (run_versions, arch 33)
 *     -- so the raw copy is one member per version, each cut out of the
 *     upload that version came from.
 *
 * A bundle line belongs to a version when the line's run hash (raw_ext's
 * content_hash, else `adapter_id:run_ref`, exactly as fn:ingest computes it)
 * is that version's content_hash.
 *
 * Like composeUploadExport this knows nothing about Supabase, and a part that
 * Storage no longer has is recorded in export.json, never thrown. Upload-wide
 * things (the full manifest, agents.json, Record Files) stay out: they
 * describe other sessions too.
 */

export const RUN_EXPORT_KIND = 'run' as const;

/** One capture of the session: where its raw copy lives. Oldest first. */
export interface RunCapture {
  version: number;
  upload_id: string | null;
  content_hash: string;
}

export interface RunExportSource {
  /** The runs row, as the caller's RLS returns it. */
  run: Json;
  /** run_versions rows; may be empty for a run that predates them. */
  versions: Json[];
  /** `runs/…` part names of an upload's bundle; null when the upload is not visible or gone. */
  bundleParts(uploadId: string): Promise<string[] | null>;
  /** Bytes of one bundle part; null when the object is gone. */
  bundleFile(uploadId: string, name: string): Promise<Uint8Array | AsyncIterable<Uint8Array> | null>;
  turns(runId: string): Promise<Json[]>;
  artifacts(runId: string): Promise<Json[]>;
  /** entries joined with their entry_sources (as `sources: [{turn_id, ord}]`). */
  entries(runId: string): Promise<Json[]>;
  agents(agentIds: string[]): Promise<Json[]>;
}

export interface RunExportMeta {
  format: typeof EXPORT_FORMAT;
  kind: typeof RUN_EXPORT_KIND;
  exported_at: string;
  exported_by: string;
  /** Always true: the server holds pseudonyms only. `actario unmask` is the local step. */
  pseudonymized: true;
  run: { id: string; workspace_id: string; title: string | null; platform: string | null; version: number | null };
  captures: {
    version: number;
    upload_id: string | null;
    content_hash: string;
    /** `bundle/v0001.ndjson.gz`, or null when no line of this version was found. */
    member: string | null;
    lines: number;
  }[];
  counts: { captures: number; bundle_lines: number; turns: number; artifacts: number; entries: number; agents: number };
  /** What could not be included, and why. */
  missing: { upload_id: string | null; name: string | null; reason: 'upload_not_visible' | 'not_found' | 'unsafe_name' | 'line_not_found' }[];
  bytes: { bundle: number };
}

const enc = new TextEncoder();
const jsonl = (rows: Json[]): Uint8Array => enc.encode(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const json = (v: unknown): Uint8Array => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
const uniq = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];
const safePart = (name: string): boolean =>
  /^runs\/[A-Za-z0-9._-]+$/.test(name) && !name.split('/').includes('..');

/** The captures to cut, oldest first. A run with no run_versions rows is its own single capture. */
export function runCaptures(run: Json, versions: Json[]): RunCapture[] {
  const vs = versions
    .map((v) => ({
      version: Number(v.version),
      upload_id: (v.upload_id as string | null) ?? null,
      content_hash: String(v.content_hash ?? ''),
    }))
    .filter((v) => Number.isInteger(v.version) && v.content_hash)
    .sort((a, b) => a.version - b.version);
  if (vs.length > 0) return vs;
  return [{
    version: Number(run.version ?? 1) || 1,
    upload_id: (run.upload_id as string | null) ?? null,
    content_hash: String(run.content_hash ?? ''),
  }];
}

/** fn:ingest's runHashOfUcf, over a parsed bundle line. */
export function bundleLineHash(line: Json): string | null {
  const ext = line.raw_ext as { content_hash?: unknown } | undefined;
  if (ext && typeof ext.content_hash === 'string') return ext.content_hash;
  if (typeof line.adapter_id === 'string' && typeof line.run_ref === 'string') return `${line.adapter_id}:${line.run_ref}`;
  return null;
}

/** Lines of a gzipped NDJSON part, streamed: a part is up to 32 MB compressed. */
async function* gzLines(data: Uint8Array | AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const input = data instanceof Uint8Array ? Readable.from([Buffer.from(data)]) : Readable.from(data);
  const gunzip = input.pipe(createGunzip());
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  try {
    for await (const line of rl) if (line.trim()) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}

/**
 * Yields the archive's entries in order; `export.json` comes last, as in the
 * per-upload export, because its counts are only known at the end.
 */
export async function* composeRunExport(
  src: RunExportSource,
  opts: { exportedBy: string; now?: () => Date },
): AsyncGenerator<ZipEntry> {
  const now = (opts.now ?? (() => new Date()))();
  const run = src.run;
  const runId = String(run.id);
  const mtime = new Date(String(run.last_captured_at ?? run.created_at ?? now.toISOString()));

  // ── DB copy: this session only ──
  const [turns, artifacts, entries] = await Promise.all([src.turns(runId), src.artifacts(runId), src.entries(runId)]);
  const agentIds = uniq([run.agent_id as string | null, ...entries.map((e) => e.agent_id as string | null)]);
  const agents = agentIds.length ? await src.agents(agentIds) : [];

  yield { name: 'db/runs.jsonl', data: jsonl([run]), mtime };
  yield { name: 'db/run_versions.jsonl', data: jsonl(src.versions), mtime };
  yield { name: 'db/turns.jsonl', data: jsonl(turns), mtime };
  yield { name: 'db/artifacts.jsonl', data: jsonl(artifacts), mtime };
  yield { name: 'db/entries.jsonl', data: jsonl(entries), mtime };
  yield { name: 'db/agents.json', data: json(agents), mtime };

  // ── raw copy: per capture, this session's lines cut out of that upload's bundle ──
  const captures: RunExportMeta['captures'] = [];
  const missing: RunExportMeta['missing'] = [];
  let bundleBytes = 0;
  let bundleLines = 0;
  for (const c of runCaptures(run, src.versions)) {
    const parts = c.upload_id ? await src.bundleParts(c.upload_id) : null;
    if (!c.upload_id || parts === null) {
      missing.push({ upload_id: c.upload_id, name: null, reason: 'upload_not_visible' });
      captures.push({ ...c, member: null, lines: 0 });
      continue;
    }
    const kept: string[] = [];
    // The cheap test first: a line carrying this hash has it verbatim, unless
    // it falls back to adapter_id:run_ref, which JSON splits over two fields.
    const quick = !c.content_hash.includes(':');
    for (const name of parts) {
      if (!safePart(name)) { missing.push({ upload_id: c.upload_id, name, reason: 'unsafe_name' }); continue; }
      const data = await src.bundleFile(c.upload_id, name);
      if (data === null) { missing.push({ upload_id: c.upload_id, name, reason: 'not_found' }); continue; }
      for await (const line of gzLines(data)) {
        if (quick && !line.includes(c.content_hash)) continue;
        let parsed: Json;
        try { parsed = JSON.parse(line) as Json; } catch { continue; }
        if (bundleLineHash(parsed) === c.content_hash) kept.push(line);
      }
    }
    if (kept.length === 0) {
      missing.push({ upload_id: c.upload_id, name: null, reason: 'line_not_found' });
      captures.push({ ...c, member: null, lines: 0 });
      continue;
    }
    const member = `bundle/v${String(c.version).padStart(4, '0')}.ndjson.gz`;
    const bytes = gzipSync(Buffer.from(`${kept.join('\n')}\n`, 'utf8'), { level: 6 });
    bundleBytes += bytes.length;
    bundleLines += kept.length;
    captures.push({ ...c, member, lines: kept.length });
    yield { name: member, data: new Uint8Array(bytes), mtime };
  }

  const meta: RunExportMeta = {
    format: EXPORT_FORMAT,
    kind: RUN_EXPORT_KIND,
    exported_at: now.toISOString(),
    exported_by: opts.exportedBy,
    pseudonymized: true,
    run: {
      id: runId,
      workspace_id: String(run.workspace_id),
      title: (run.title as string | null) ?? null,
      platform: (run.platform as string | null) ?? null,
      version: run.version == null ? null : Number(run.version),
    },
    captures,
    counts: {
      captures: captures.length,
      bundle_lines: bundleLines,
      turns: turns.length,
      artifacts: artifacts.length,
      entries: entries.length,
      agents: agents.length,
    },
    missing,
    bytes: { bundle: bundleBytes },
  };
  yield { name: 'export.json', data: json(meta), mtime: now };
}

/** `actario-session-<title slug>-<id8>.zip`; the slug is ASCII-only so the header needs no encoding. */
export function runExportFileName(runId: string, title?: string | null): string {
  const slug = (title ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  return `actario-session-${slug ? `${slug}-` : ''}${runId.slice(0, 8)}.zip`;
}
