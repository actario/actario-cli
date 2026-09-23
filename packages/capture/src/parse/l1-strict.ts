import type { AdapterResult, CaptureAdapter, ParseOpts, RawUnit } from '@distill/adapters';

/**
 * L1: the strict adapter path. A thin wrapper whose only job is to make an
 * adapter throw look like a per-unit failure rather than a batch failure
 * (6.3 rule 2).
 */
export interface StrictOutcome {
  ok: boolean;
  result?: AdapterResult;
  error?: string;
}

export function parseStrict(
  adapter: CaptureAdapter,
  unit: RawUnit,
  text: string,
  parseOpts: ParseOpts = {},
): StrictOutcome {
  try {
    return { ok: true, result: adapter.toUCF(unit, text, parseOpts) };
  } catch (e) {
    return { ok: false, error: `${adapter.id}@${adapter.version}: ${(e as Error).message}` };
  }
}
