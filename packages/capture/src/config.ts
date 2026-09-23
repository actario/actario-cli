import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { actarioHome } from '@distill/shared';

/** ~/.actario -- config, state, salt, adapters, encrypted redaction map. */
export const actarioDir = (): string => actarioHome();

export const zConfig = z.object({
  version: z.literal(1).default(1),
  api_url: z.string().url().optional(),
  /** PAT with scope `capture`. Kept out of shell history by living here. */
  token: z.string().optional(),
  source_id: z.string().uuid().optional(),
  /**
   * Also decides corpus eligibility at the SOURCE (plan 9.8): 'medical' is
   * reported to the server on upload and excludes the whole source from the
   * de-identified corpus. There is deliberately no per-record override.
   */
  redaction_profile: z.enum(['medical', 'general']).default('general'),
  /** v1.2: send artifact diff bodies. Default on; `--no-diffs` turns it off. */
  upload_diffs: z.boolean().default(true),
  /** Soft rules the user reviewed and switched off. Hard rules cannot appear. */
  disabled_redaction_rules: z.array(z.string()).default([]),
  /** Extra roots to scan, for installs in non-default locations. */
  extra_paths: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof zConfig>;

const zSourceState = z.object({
  /** high-water mark: only advanced after the server confirms the upload. */
  last_seen_at: z.string().nullable().default(null),
  /** Content hashes already accepted, so a re-run is cheap client-side too. */
  uploaded_hashes: z.array(z.string()).default([]),
  last_upload_id: z.string().nullable().default(null),
});

export const zState = z.object({
  version: z.literal(1).default(1),
  sources: z.record(z.string(), zSourceState).default({}),
});
export type State = z.infer<typeof zState>;
export type SourceState = z.infer<typeof zSourceState>;

const configPath = () => join(actarioDir(), 'config.json');
const statePath = () => join(actarioDir(), 'state.json');

export function readConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return zConfig.parse({});
  return zConfig.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function writeConfig(cfg: Config): void {
  mkdirSync(actarioDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export function readState(): State {
  const p = statePath();
  if (!existsSync(p)) return zState.parse({});
  try {
    return zState.parse(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    // A corrupt state file must not block a capture; the worst case of
    // starting over is re-uploading data the server will dedupe (6.1 step 9).
    return zState.parse({});
  }
}

/**
 * Atomic write. state.json is the only thing standing between "re-upload some
 * data" and "silently lose a batch forever", so a half-written file is not an
 * acceptable failure mode.
 */
export function writeState(state: State): void {
  mkdirSync(actarioDir(), { recursive: true });
  const tmp = `${statePath()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath());
}

export function sourceState(state: State, key: string): SourceState {
  return state.sources[key] ?? { last_seen_at: null, uploaded_hashes: [], last_upload_id: null };
}

/**
 * Step 9 of the pipeline (6.1). Called only after the server has confirmed the
 * upload -- never before. Advancing first would mean a single failed upload
 * permanently skips that batch, and the user would never find out. Uploading
 * twice costs a server-side dedupe (free); missing data costs a hole in the
 * record (undetectable).
 */
export function commitHighWaterMark(
  key: string,
  /** Newest unit mtime in the uploaded batch. A file clock, never a content one. */
  newestMtime: string | null,
  hashes: string[],
  uploadId: string | null,
): void {
  const state = readState();
  const prev = sourceState(state, key);
  const merged = new Set([...prev.uploaded_hashes, ...hashes]);
  state.sources[key] = {
    last_seen_at: newestMtime ?? prev.last_seen_at,
    // Cap the ledger: dedupe is authoritative server-side anyway.
    uploaded_hashes: [...merged].slice(-20_000),
    last_upload_id: uploadId ?? prev.last_upload_id,
  };
  writeState(state);
}
