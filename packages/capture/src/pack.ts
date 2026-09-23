import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import type { BundleMeta, CaptureReport, ManifestFile } from '@distill/shared';
import type { UcfAgent, UcfRun } from '@distill/ucf';

/**
 * Physical bundle format (7.1) -- split NDJSON, not one big JSON object.
 *
 * A single Claude Code session file is tens of megabytes; 148 of them in one
 * JSON document would force both the CLI and the worker to hold the whole
 * thing in memory, and would exceed the Inngest step payload limit. So:
 *
 *   bundle-<uuid>/
 *     manifest.json          bundle_meta + capture_report + files[] + sha256
 *     agents.json            small, single file
 *     runs/000001.ndjson.gz  one run per line, rotated at 32 MB compressed
 *
 * The logical UCF schema is unchanged -- `packages/ucf` validates both shapes.
 */
export const MAX_PART_BYTES = 32 * 1024 * 1024;

class RotatingNdjsonWriter {
  private index = 0;
  private gzip: ReturnType<typeof createGzip> | null = null;
  private out: ReturnType<typeof createWriteStream> | null = null;
  private current: string | null = null;
  readonly parts: string[] = [];

  constructor(private readonly dir: string, private readonly maxBytes = MAX_PART_BYTES) {}

  private async open(): Promise<void> {
    this.index += 1;
    const name = `runs/${String(this.index).padStart(6, '0')}.ndjson.gz`;
    this.current = name;
    const path = join(this.dir, name);
    await mkdir(join(this.dir, 'runs'), { recursive: true });
    this.out = createWriteStream(path);
    this.gzip = createGzip({ level: 6 });
    this.gzip.pipe(this.out);
    this.parts.push(name);
  }

  async write(obj: unknown): Promise<void> {
    if (!this.gzip) await this.open();
    const line = `${JSON.stringify(obj)}\n`;
    if (!this.gzip!.write(line)) await once(this.gzip!, 'drain');
    // Rotate on *compressed* bytes actually on disk, which is the limit that
    // matters for a single-file retry.
    if ((this.out!.bytesWritten ?? 0) >= this.maxBytes) await this.rotate();
  }

  private async rotate(): Promise<void> {
    await this.closeCurrent();
    await this.open();
  }

  private async closeCurrent(): Promise<void> {
    if (!this.gzip || !this.out) return;
    const out = this.out;
    this.gzip.end();
    await once(out, 'finish');
    this.gzip = null;
    this.out = null;
    this.current = null;
  }

  async close(): Promise<string[]> {
    await this.closeCurrent();
    return this.parts;
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject);
  });
  const s = await stat(path);
  return { sha256: h.digest('hex'), bytes: s.size };
}

export interface PackInput {
  outDir: string;
  bundleMeta: BundleMeta;
  captureReport: CaptureReport;
  agents: UcfAgent[];
  runs: AsyncIterable<UcfRun> | UcfRun[];
  droppedRuns: { run_ref: string; reason: string; parse_level?: string }[];
  /** Overridable for tests; production uses MAX_PART_BYTES. */
  maxPartBytes?: number;
}

export interface PackResult {
  bundleDir: string;
  files: ManifestFile[];
  manifestPath: string;
}

export async function packBundle(input: PackInput): Promise<PackResult> {
  const bundleDir = join(input.outDir, `bundle-${input.bundleMeta.bundle_id}`);
  await mkdir(bundleDir, { recursive: true });

  const writer = new RotatingNdjsonWriter(bundleDir, input.maxPartBytes ?? MAX_PART_BYTES);
  for await (const run of input.runs as AsyncIterable<UcfRun>) await writer.write(run);
  const parts = await writer.close();

  const agentsName = 'agents.json';
  await writeFile(
    join(bundleDir, agentsName),
    `${JSON.stringify({ ucf_version: '0.2', agents: input.agents }, null, 2)}\n`,
    'utf8',
  );

  const files: ManifestFile[] = [];
  for (const name of [agentsName, ...parts]) {
    const { sha256, bytes } = await hashFile(join(bundleDir, name));
    files.push({ name, bytes, sha256 });
  }

  // manifest.json is not itself in files[]: it is the declaration the server
  // checks the uploaded objects against (7.2, step 3).
  const manifestPath = join(bundleDir, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      bundle_meta: input.bundleMeta,
      capture_report: input.captureReport,
      dropped_runs: input.droppedRuns,
      files,
    }, null, 2)}\n`,
    'utf8',
  );

  return { bundleDir, files, manifestPath };
}

export async function readManifest(bundleDir: string) {
  return JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8')) as {
    bundle_meta: BundleMeta;
    capture_report: CaptureReport;
    dropped_runs: { run_ref: string; reason: string }[];
    files: ManifestFile[];
  };
}
