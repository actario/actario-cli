import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { CaptureAdapter, LocalEnv } from '@distill/adapters';
import { adapterKey } from '@distill/adapters';
import { RedactionEngine } from '@distill/redaction';
import { actarioEnv, logger, runContentHash, uuid } from '@distill/shared';
import type { BundleMeta, CaptureReport } from '@distill/shared';
import { validateRun } from '@distill/ucf';
import type { UcfAgent, UcfRun } from '@distill/ucf';
import { parseLoose, parseRaw, parseStrict, sniffUnit } from './parse/index.ts';
import { packBundle, type PackResult } from './pack.ts';
import { score, type DroppedRun, type ScoreResult } from './score.ts';
import { sourceState, type State } from './config.ts';

export function localEnv(extraPaths: string[] = []): LocalEnv {
  const home = homedir();
  return {
    homedir: home,
    platform: platform(),
    extraPaths,
    downloadsDir: actarioEnv('DOWNLOADS') ?? join(home, 'Downloads'),
  };
}

export interface CaptureOptions {
  env: LocalEnv;
  adapters: CaptureAdapter[];
  state: State;
  outDir: string;
  cliVersion: string;
  profile: 'medical' | 'general';
  salt: string;
  since?: Date;
  /** Adapter ids to include; empty means all detected. */
  sources?: string[];
  allowSoft?: boolean;
  disabledRuleIds?: string[];
  /** Skip packing; used by `--dry-run` and by `doctor`. */
  noPack?: boolean;
  /** v1.2: attach artifact diff bodies (`sources.upload_diffs`). Default true. */
  uploadDiffs?: boolean;
}

export interface CaptureOutcome {
  bundleMeta: BundleMeta;
  report: CaptureReport;
  verdict: ScoreResult['verdict'];
  remediation: string[];
  pack: PackResult | null;
  runs: UcfRun[];
  agents: UcfAgent[];
  dropped: DroppedRun[];
  /** Per (adapter id + version) content hashes, for the high-water commit. */
  hashesByAdapter: Record<string, string[]>;
  /**
   * Per adapter, the newest file mtime among the units that produced runs.
   * This -- not the report's coverage_end -- is what the high-water mark must
   * be set to, because collect() compares it against file mtimes. Committing
   * a content timestamp and comparing it to a file clock silently skipped
   * every session whose file was last written before the newest message in
   * the previous batch: 11 of 49 on the first real machine.
   */
  maxMtimeByAdapter: Record<string, string | null>;
  redactionMap: { version: 1; entries: { original: string; pseudonym: string }[] };
  skippedDuplicates: number;
}

/**
 * The capture pipeline (6.1):
 *   detect -> collect -> adapt -> validate -> redact -> score -> pack
 * `push` and `commit` live in the CLI, because committing the high-water mark
 * is only allowed after the server has confirmed the upload (step 9).
 *
 * The invariant threaded through every step: a failure is isolated to one run.
 * Not one file, and never the batch (C5).
 */
export async function runCapture(opts: CaptureOptions): Promise<CaptureOutcome> {
  const engine = new RedactionEngine({
    profile: opts.profile,
    salt: opts.salt,
    allowSoft: opts.allowSoft,
    disabledRuleIds: opts.disabledRuleIds,
  });

  const wanted = new Set(opts.sources ?? []);
  const byId = new Map<string, CaptureAdapter[]>();
  for (const a of opts.adapters) {
    if (wanted.size > 0 && !wanted.has(a.id)) continue;
    byId.set(a.id, [...(byId.get(a.id) ?? []), a]);
  }

  const runs: UcfRun[] = [];
  const agents = new Map<string, UcfAgent>();
  /**
   * Units already handled, across all adapters.
   *
   * Two adapters can legitimately find the same file: an unpacked ChatGPT
   * export and an unpacked Claude export are both `conversations.json`. The
   * first adapter whose sniff accepts a unit owns it; the others must not
   * re-ingest it, or the same conversation lands twice under two platforms.
   * Content-hash dedupe does not save us here -- two parsers produce two
   * different hashes for the same conversation.
   */
  const claimedUnits = new Set<string>();
  const dropped: DroppedRun[] = [];
  const adapterReports: CaptureReport['adapters'] = [];
  const hashesByAdapter: Record<string, string[]> = {};
  const maxMtimeByAdapter: Record<string, string | null> = {};
  let skippedDuplicates = 0;

  for (const [id, versions] of byId) {
    const primary = versions[0]!;
    let detected;
    try {
      detected = await primary.detect(opts.env);
    } catch (e) {
      adapterReports.push({
        adapter_id: id, adapter_version: primary.version, runs: 0, ok: false,
        error: `detect failed: ${(e as Error).message}`,
      });
      continue;
    }
    if (!detected.found) {
      logger.info('source not present', { adapter: id, note: detected.note });
      continue;
    }

    const key = adapterKey(primary);
    const prev = sourceState(opts.state, key);
    const seen = new Set(prev.uploaded_hashes);
    let produced = 0;

    try {
      for await (const unit of primary.collect({
        env: opts.env,
        paths: detected.paths,
        ...(opts.since ? { since: opts.since } : {}),
        ...(prev.last_seen_at && !opts.since ? { lastSeenAt: prev.last_seen_at } : {}),
      })) {
        const unitKey = `${unit.path}::${unit.unitId}`;
        if (claimedUnits.has(unitKey)) continue;

        let text: string;
        try {
          text = await unit.read();
        } catch (e) {
          dropped.push({ run_ref: unit.unitId, reason: `unreadable: ${(e as Error).message}` });
          continue;
        }

        // ── adapt: three-tier fallback, decided per unit (6.3) ──
        const sniffed = sniffUnit(text, versions);

        // Degrade only when *nobody* can parse this strictly. Without this
        // check, an adapter that merely found the file would loose-parse a
        // format another adapter understands perfectly.
        if (sniffed.level !== 'strict') {
          const ownedElsewhere = opts.adapters.some(
            (other) => other.id !== id && safeSniff(other, text),
          );
          if (ownedElsewhere) continue;
        }
        claimedUnits.add(unitKey);

        let drafts;
        if (sniffed.level === 'strict' && sniffed.adapter) {
          const strict = parseStrict(sniffed.adapter, unit, text, { uploadDiffs: opts.uploadDiffs ?? true });
          if (strict.ok && strict.result) {
            drafts = strict.result.runs;
            for (const a of strict.result.agents) agents.set(a.agent_ref, a);
          } else {
            // A strict adapter that throws is a format change, not a dead end.
            logger.warn('strict parse failed, falling back to loose', {
              unit: unit.unitId, error: strict.error,
            });
            drafts = parseLoose(unit, text);
            if (drafts.length === 0) drafts = parseRaw(unit, text);
          }
        } else if (sniffed.level === 'loose') {
          drafts = parseLoose(unit, text);
          if (drafts.length === 0) drafts = parseRaw(unit, text);
        } else {
          drafts = parseRaw(unit, text);
        }

        for (const draft of drafts) {
          // ── validate ──
          const verdict = validateRun(draft);
          if (!verdict.ok) {
            dropped.push({
              run_ref: draft.run_ref ?? unit.unitId,
              reason: `${verdict.reason}: ${verdict.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
              parse_level: draft.parse_level,
            });
            continue;
          }

          // ── redact: before anything leaves the machine (C6) ──
          const run = redactRun(engine, verdict.run);

          const hash = runContentHash({
            platform: run.platform,
            startedAt: run.started_at,
            turns: run.turns.map((t) => ({ role: t.role, content: t.content })),
          });
          if (seen.has(hash)) { skippedDuplicates++; continue; }
          seen.add(hash);

          run.raw_ext = { ...run.raw_ext, content_hash: hash };
          runs.push(run);
          (hashesByAdapter[key] ??= []).push(hash);
          if (unit.mtime && (!maxMtimeByAdapter[key] || unit.mtime > maxMtimeByAdapter[key]!)) {
            maxMtimeByAdapter[key] = unit.mtime;
          }
          produced++;
        }
      }
      adapterReports.push({ adapter_id: id, adapter_version: primary.version, runs: produced, ok: true });
    } catch (e) {
      // Whole-source failure: other sources still upload, status becomes
      // 'partial' server-side (13.3).
      adapterReports.push({
        adapter_id: id, adapter_version: primary.version, runs: produced, ok: false,
        error: (e as Error).message,
      });
    }
  }

  // ── score ──
  const scored = score({
    runs,
    dropped,
    adapters: adapterReports,
    redactions: engine.summary(),
    profile: opts.profile,
  });

  const bundleMeta: BundleMeta = {
    bundle_id: uuid(),
    ucf_version: '0.2',
    cli_version: opts.cliVersion,
    created_at: new Date().toISOString(),
    host_os: `${opts.env.platform}`,
    redaction_profile: opts.profile,
    hard_rules_enforced: true,
  };

  // ── pack ──
  const pack = opts.noPack || scored.verdict === 'reject'
    ? null
    : await packBundle({
        outDir: opts.outDir,
        bundleMeta,
        captureReport: scored.report,
        agents: [...agents.values()],
        runs,
        droppedRuns: dropped,
      });

  return {
    bundleMeta,
    report: scored.report,
    verdict: scored.verdict,
    remediation: scored.remediation,
    pack,
    runs,
    agents: [...agents.values()],
    dropped,
    hashesByAdapter,
    maxMtimeByAdapter,
    redactionMap: engine.exportMap(),
    skippedDuplicates,
  };
}

function safeSniff(adapter: CaptureAdapter, text: string): boolean {
  try { return adapter.sniff(text); } catch { return false; }
}

/**
 * Redaction touches every string that leaves the machine (6.5, C6). The v1.2
 * fields -- tool_result, diff_body, full tool params -- are exactly the ones
 * most likely to carry a credential (a `Read` of .env, a `Write` of a config),
 * so a field added to UCF and forgotten here is a C6 hole. The pack step
 * asserts nothing; this function is the guarantee.
 */
function redactRun(engine: RedactionEngine, run: UcfRun): UcfRun {
  return {
    ...run,
    title: run.title ? engine.redactText(run.title).text : null,
    turns: run.turns.map((t) => ({
      ...t,
      content: engine.redactText(t.content).text,
      tool_result: t.tool_result != null ? engine.redactText(t.tool_result).text : null,
      tool_calls: t.tool_calls
        ? t.tool_calls.map((c) => ({ ...c, params: engine.redactDeep(c.params) }))
        : null,
      raw_ext: engine.redactDeep(t.raw_ext),
    })),
    artifacts: run.artifacts.map((a) => ({
      ...a,
      path: engine.redactText(a.path).text,
      diff_summary: a.diff_summary ? engine.redactText(a.diff_summary).text : null,
      diff_body: a.diff_body != null ? engine.redactText(a.diff_body).text : null,
    })),
    raw_ext: engine.redactDeep(run.raw_ext),
  };
}
