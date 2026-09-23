/**
 * CQS weights (6.6).
 *
 * Versioned, and the version is written into every capture_report. Weights
 * will be tuned -- what matters is that a score from three months ago can
 * still be understood as "computed under v1".
 */
export const CQS_VERSION = 'cqs-v1' as const;

/**
 * Points deducted when a field the source *claims to have* could not be read,
 * scaled by the fraction of runs affected. Fields the source never had cost
 * nothing (6.2) -- that asymmetry is the whole reason CQS is worth showing.
 */
export const FIELD_WEIGHTS: Record<string, number> = {
  role: 20,              // level raw: we do not know who said what
  platform: 4,
  tool_calls: 12,        // the difference between a state summary and a guess
  artifacts: 8,
  turn_timestamps: 6,
  outcome: 4,
  model: 2,
  title: 1,
  malformed_lines: 5,
};

export const COVERAGE_GAP_WEIGHT = 0.3;
export const TRUNCATION_WEIGHT = 0.5;

/** Below this, capture refuses to upload and prints a remediation list. */
export const CQS_REJECT_BELOW = 40;
/** Below this, capture warns but proceeds. */
export const CQS_WARN_BELOW = 70;
/** More than this share of runs dropped for a missing required field = unfit. */
export const MAX_DROPPED_FRACTION = 0.3;
