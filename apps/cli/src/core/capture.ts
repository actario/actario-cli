import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allAdapters, inboxDir } from '@distill/adapters';
import {
  commitHighWaterMark, actarioDir, keepBundle, localEnv, readConfig, readState, runCapture,
  type CaptureOutcome, type Config,
} from '@distill/capture';
import { ensureSalt, writeEncrypted } from '@distill/redaction';
import { actarioEnv, DistillError, parseSince } from '@distill/shared';
import { CLI_VERSION } from '../version.ts';
import { pushBundle } from '../api.ts';

/**
 * The capture flow, without a terminal.
 *
 * `actario capture` and the `capture` MCP tool are the same sequence -- scan,
 * redact, score, pack, upload, advance the mark, keep the bundle -- with two
 * different ways of telling the caller what happened. This file is the
 * sequence; the command prints it and the tool serialises it. One
 * implementation is the point: the redaction rules run here and nowhere
 * else, so there is no second copy for them to drift from (C6).
 *
 * Nothing in here writes to stdout or calls process.exit. Every way the flow
 * can end is a value in `CaptureFlowResult`, including the failures, so the
 * MCP tool can hand the agent a structured answer and the CLI can pick the
 * exit code it has always used.
 */
export interface CaptureFlowOptions {
  dryRun?: boolean;
  /** Personal-data rules off for this run. Credential rules stay on regardless (C6). */
  noRedact?: boolean;
  noDiffs?: boolean;
  sources?: string[];
  since?: string;
  apiUrl?: string;
}

export type CaptureFlowResult =
  /** Every session was already captured. Routine, not a failure (R17). */
  | { kind: 'up_to_date'; skippedDuplicates: number; adapters: string[] }
  /** CQS below the threshold: nothing uploaded, remediation attached. */
  | { kind: 'rejected'; outcome: CaptureOutcome }
  | { kind: 'dry_run'; outcome: CaptureOutcome }
  /** Packed but this machine has no api_url / token / source_id. */
  | { kind: 'not_linked'; outcome: CaptureOutcome; bundleDir: string }
  | { kind: 'uploaded'; outcome: CaptureOutcome; uploadId: string; bundleId: string; files: number; resumed: boolean; keptAt: string | null; keepError: string | null }
  | { kind: 'upload_failed'; outcome: CaptureOutcome; bundleDir: string; error: DistillError };

export async function captureFlow(opts: CaptureFlowOptions = {}): Promise<CaptureFlowResult> {
  const cfg = readConfig();
  const dir = actarioDir();
  const salt = ensureSalt(dir);

  const outcome = await runCapture({
    env: localEnv(cfg.extra_paths),
    adapters: await allAdapters(join(dir, 'adapters')),
    state: readState(),
    outDir: await mkdtemp(join(tmpdir(), 'actario-bundle-')),
    cliVersion: CLI_VERSION,
    profile: cfg.redaction_profile,
    uploadDiffs: opts.noDiffs ? false : cfg.upload_diffs,
    salt,
    ...(opts.since ? { since: parseSince(opts.since) } : {}),
    ...(opts.sources && opts.sources.length > 0 ? { sources: opts.sources } : {}),
    allowSoft: !opts.noRedact,
    disabledRuleIds: cfg.disabled_redaction_rules,
    noPack: opts.dryRun ?? false,
  });

  // "Nothing new" has duplicates to prove it; "nothing at all" does not.
  // Only the first is routine. See the command for why R17 makes this worth
  // a case of its own rather than a line in the remediation list.
  if (outcome.report.runs_total === 0 && outcome.skippedDuplicates > 0 && outcome.report.adapters.every((a) => a.ok)) {
    return { kind: 'up_to_date', skippedDuplicates: outcome.skippedDuplicates, adapters: outcome.report.adapters.map((a) => a.adapter_id) };
  }

  // The redaction map never leaves the machine (13.1). Written after scoring
  // so a rejected capture still leaves the mapping for the next attempt.
  if (outcome.redactionMap.entries.length > 0) {
    writeEncrypted(join(dir, 'redaction_map.json.enc'), salt, outcome.redactionMap);
  }

  if (outcome.verdict === 'reject') return { kind: 'rejected', outcome };
  if (opts.dryRun) return { kind: 'dry_run', outcome };
  if (!outcome.pack) throw new DistillError('internal', 'Nothing to upload.');

  const link = resolveLink(cfg, opts.apiUrl);
  if (!link) return { kind: 'not_linked', outcome, bundleDir: outcome.pack.bundleDir };

  try {
    const push = await pushBundle({ baseUrl: link.apiUrl, token: link.token }, {
      sourceId: link.sourceId,
      bundleDir: outcome.pack.bundleDir,
      bundleMeta: outcome.bundleMeta,
      captureReport: outcome.report,
      files: outcome.pack.files,
    });

    // The high-water mark advances only now, after the server confirmed the
    // manifest (6.1). It is a FILE clock, because that is what collect()
    // compares it to; committing the content clock here skipped 11 of 49
    // sessions on the first real machine.
    for (const [adapter, hashes] of Object.entries(outcome.hashesByAdapter)) {
      commitHighWaterMark(adapter, outcome.maxMtimeByAdapter[adapter] ?? null, hashes, push.uploadId);
    }

    // v1.3: the bundle stays here so `analyze` reads the same runs the
    // server holds -- kept only after confirmation, alongside the mark.
    let keptAt: string | null = null;
    let keepError: string | null = null;
    try {
      keptAt = keepBundle(outcome.pack.bundleDir, {
        bundle_id: outcome.bundleMeta.bundle_id, upload_id: push.uploadId, runs: outcome.report.runs_kept,
      });
    } catch (e) { keepError = (e as Error).message; }

    return {
      kind: 'uploaded', outcome, uploadId: push.uploadId, bundleId: outcome.bundleMeta.bundle_id,
      files: push.uploaded.length, resumed: push.resumed, keptAt, keepError,
    };
  } catch (e) {
    const err = e instanceof DistillError ? e : new DistillError('internal', (e as Error).message);
    return { kind: 'upload_failed', outcome, bundleDir: outcome.pack.bundleDir, error: err };
  }
}

export interface Link { apiUrl: string; token: string; sourceId: string }

/** Config first, environment second. Null when any of the three is missing. */
export function resolveLink(cfg: Config, apiUrlOverride?: string): Link | null {
  const apiUrl = apiUrlOverride ?? cfg.api_url ?? actarioEnv('API_URL');
  const token = cfg.token ?? actarioEnv('TOKEN');
  const sourceId = cfg.source_id ?? actarioEnv('SOURCE_ID');
  return apiUrl && token && sourceId ? { apiUrl, token, sourceId } : null;
}

/**
 * Drops a distill.chat/v1 record into the inbox the cowork_live adapter
 * scans, and returns its path. The agent's half of the export skill, as a
 * function: the file must sit directly in inbox/ and end in .chat.json, and
 * the name carries a UTC stamp so two records from one minute do not collide.
 *
 * The record is written verbatim. Redaction is the capture pipeline's job and
 * happens on the next step, on every record, with rules no flag reaches (C6);
 * redacting here would be a second, weaker copy of that guarantee.
 */
export function writeChatRecord(record: unknown, slug: string): string {
  const dir = inboxDir(localEnv(readConfig().extra_paths));
  mkdirSync(dir, { recursive: true });
  // Seconds, not minutes: two records in one minute must not share a name.
  // And never overwrite -- an existing file gets a numeric suffix, because a
  // silently replaced record is a lost conversation with no error.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T');
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat';
  let path = join(dir, `${stamp}-${safe}.chat.json`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stamp}-${safe}-${n}.chat.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}
