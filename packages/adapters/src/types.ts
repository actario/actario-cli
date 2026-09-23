import type { UcfAgent, UcfRunDraft } from '@distill/ucf';

/** What the CLI knows about the machine it is running on. */
export interface LocalEnv {
  homedir: string;
  platform: NodeJS.Platform;
  /** Extra roots from ~/.actario/config.json, checked in addition to defaults. */
  extraPaths: string[];
  downloadsDir: string;
}

export interface DetectResult {
  found: boolean;
  /** Concrete files or directories this adapter will read. */
  paths: string[];
  /** Rough unit count for the pre-flight report. Cheap estimate, not exact. */
  approxUnits: number;
  /** Shown by `actario doctor`; explains a `found: false` in plain language. */
  note?: string;
}

/**
 * One unit = one prospective run (one session file, one exported
 * conversation). The isolation unit for a parse failure is this (6.3 rule 2),
 * which is why `read()` is lazy: a unit that explodes takes only itself down.
 */
export interface RawUnit {
  unitId: string;
  path: string;
  bytes: number;
  mtime: string | null;
  read(): Promise<string>;
}

export interface CollectOpts {
  env: LocalEnv;
  paths: string[];
  since?: Date;
  /** high-water mark from state.json; units at or before this are skipped. */
  lastSeenAt?: string;
}

/**
 * What a source *structurally* has. This is the field that makes "missing" mean
 * two different things (6.2):
 *   - false here  -> the source never had it. Costs no CQS points, no warning.
 *   - true here, but nothing parsed -> the format probably changed. Costs
 *     points, marks the run degraded, and is what `actario doctor` reports.
 * Without the distinction, CQS would permanently punish plain chat exports and
 * would then be ignored.
 */
export interface AdapterCapabilities {
  hasTurnTimestamps: boolean;
  hasToolCalls: boolean;
  hasArtifacts: boolean;
  hasBranches: boolean;
  hasOutcome: boolean;
}

export interface AdapterResult {
  runs: UcfRunDraft[];
  agents: UcfAgent[];
}

export interface CaptureAdapter {
  id: string;
  /** The adapter's own version, recorded on every run it produces. */
  version: string;
  capabilities: AdapterCapabilities;
  detect(env: LocalEnv): Promise<DetectResult>;
  collect(opts: CollectOpts): AsyncIterable<RawUnit>;
  /**
   * Sniff test for multi-version adapters (6.3 rule 3): does this unit look
   * like the format this adapter version handles? All sniffs failing is what
   * sends a unit to the L2 loose parser rather than to an error.
   */
  sniff(text: string): boolean;
  /** Pure: text in, UCF out. No IO, no DB, unit-testable (P4). */
  toUCF(unit: RawUnit, text: string, opts?: ParseOpts): AdapterResult;
}

/**
 * Per-capture switches an adapter may honour. Everything here defaults to the
 * setting that produces the most complete record, because that is the one
 * that needs no configuration and the corpus is worth more for it (v1.2).
 */
export interface ParseOpts {
  /** Attach artifact diff bodies (`sources.upload_diffs`). Default true. */
  uploadDiffs?: boolean;
}

export const absentFields = (c: AdapterCapabilities): string[] => {
  const absent: string[] = [];
  if (!c.hasTurnTimestamps) absent.push('turn_timestamps');
  if (!c.hasToolCalls) absent.push('tool_calls');
  if (!c.hasArtifacts) absent.push('artifacts');
  if (!c.hasBranches) absent.push('branches');
  if (!c.hasOutcome) absent.push('outcome');
  return absent;
};
