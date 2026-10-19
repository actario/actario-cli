import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { parseRunLine, type UcfRun } from '@distill/ucf';
import { actarioDir } from './config.ts';
import { readManifest } from './pack.ts';

/**
 * The local bundle store -- ~/.actario/bundles/<bundle_id>/ (arch v1.3 §18.7).
 *
 * Until v1.3 a bundle lived in a temp directory for the length of one
 * `capture` and was gone. Analysis now happens in a second command, in the
 * user's own agent session, and that command needs the raw runs the server
 * has -- so the bundle stays, keyed by the same bundle_id the server files
 * the upload under. `actario analyze` reads the newest one by default and
 * `--bundle <id>` picks an older one; a bundle not on this machine any more
 * comes back through the export (unit 0001), which is the mechanism §18.7
 * names for "the user can always re-run, for free".
 *
 * Only the newest KEEP bundles are retained. They are gzip NDJSON of the
 * user's own redacted sessions, so the cost is disk, not privacy -- but a
 * heavy Claude Code user makes ~1.2 MB per weekly capture (plan 13.3), and
 * an unbounded store on a laptop is a complaint waiting to be filed.
 */
export const KEEP_BUNDLES = 10;

export const bundlesDir = (): string => join(actarioDir(), 'bundles');

const zIndexEntry = z.object({
  bundle_id: z.string().uuid(),
  upload_id: z.string().uuid().nullable(),
  captured_at: z.string(),
  runs: z.number().int().nonnegative(),
  /** 'capture' -- kept after `actario capture`; 'export' -- pulled back with `actario analyze --bundle` */
  origin: z.enum(['capture', 'export']),
});
const zIndex = z.object({ version: z.literal(1).default(1), bundles: z.array(zIndexEntry).default([]) });
export type BundleIndexEntry = z.infer<typeof zIndexEntry>;

const indexPath = () => join(bundlesDir(), 'index.json');

export function readBundleIndex(): BundleIndexEntry[] {
  const p = indexPath();
  if (!existsSync(p)) return [];
  try { return zIndex.parse(JSON.parse(readFileSync(p, 'utf8'))).bundles; } catch { return []; }
}

function writeBundleIndex(bundles: BundleIndexEntry[]): void {
  mkdirSync(bundlesDir(), { recursive: true });
  const tmp = `${indexPath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, bundles }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, indexPath());
}

export const bundleDirFor = (bundleId: string): string => join(bundlesDir(), bundleId);

/**
 * Moves (or copies, across devices) a packed bundle into the store and records
 * it. Called after the server confirmed the upload -- the same moment the
 * high-water mark advances -- so the store never holds a bundle the server
 * does not.
 */
export function keepBundle(
  packedDir: string,
  entry: Omit<BundleIndexEntry, 'captured_at' | 'origin'> & { captured_at?: string; origin?: BundleIndexEntry['origin'] },
): string {
  const dest = bundleDirFor(entry.bundle_id);
  mkdirSync(bundlesDir(), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  try { renameSync(packedDir, dest); } catch {
    // Temp and home on different volumes: rename fails with EXDEV, copy instead.
    cpSync(packedDir, dest, { recursive: true });
    rmSync(packedDir, { recursive: true, force: true });
  }
  recordBundle({ ...entry, captured_at: entry.captured_at ?? new Date().toISOString(), origin: entry.origin ?? 'capture' });
  return dest;
}

/** Index-only update, for a bundle written straight into the store (the export path). */
export function recordBundle(entry: BundleIndexEntry): void {
  const rest = readBundleIndex().filter((b) => b.bundle_id !== entry.bundle_id);
  const all = [entry, ...rest].sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1));
  const kept = all.slice(0, KEEP_BUNDLES);
  for (const gone of all.slice(KEEP_BUNDLES)) {
    rmSync(bundleDirFor(gone.bundle_id), { recursive: true, force: true });
  }
  writeBundleIndex(kept);
}

/**
 * bundle_id, upload_id, or an unambiguous prefix of either. Returns null when
 * nothing local matches -- the caller decides whether to go to the export.
 */
export function findBundle(idOrPrefix: string): BundleIndexEntry | null | 'ambiguous' {
  const needle = idOrPrefix.toLowerCase();
  const hits = readBundleIndex().filter((b) =>
    b.bundle_id.startsWith(needle) || (b.upload_id?.startsWith(needle) ?? false));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) return null;
  const exact = hits.find((b) => b.bundle_id === needle || b.upload_id === needle);
  return exact ?? 'ambiguous';
}

export function latestBundle(): BundleIndexEntry | null {
  return readBundleIndex()[0] ?? null;
}

/**
 * Streams the runs of a stored bundle, in manifest order. Lines that fail
 * validation are yielded as failures rather than thrown: the isolation unit
 * is the run (6.3 rule 2), here as on the server.
 */
export async function* readBundleRuns(bundleDir: string): AsyncGenerator<
  { ok: true; run: UcfRun } | { ok: false; part: string; lineNo: number; reason: string }
> {
  const manifest = await readManifest(bundleDir);
  const parts = manifest.files.map((f) => f.name).filter((n) => n.startsWith('runs/')).sort();
  for (const part of parts) {
    const rl = createInterface({ input: createReadStream(join(bundleDir, part)).pipe(createGunzip()), crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (line.trim().length === 0) continue;
      const parsed = parseRunLine(line);
      if (parsed.ok) yield { ok: true, run: parsed.run };
      else yield { ok: false, part, lineNo, reason: parsed.reason };
    }
  }
}
