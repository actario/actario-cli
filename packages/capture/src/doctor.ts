import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureAdapter, LocalEnv } from '@distill/adapters';
import { adapterKey } from '@distill/adapters';
import { RedactionEngine } from '@distill/redaction';
import { parseLoose, parseStrict, sniffUnit } from './parse/index.ts';

/**
 * `actario doctor` (6.3 rule 4).
 *
 * This is the only mechanism that tells you a source format changed. Without
 * it the signal is CQS drifting downward for reasons nobody can name.
 *
 * For each source: is it there, which parse level would each file take, and
 * which keys went unrecognised. `--dump-sample` writes a de-identified sample
 * that is safe to attach to a bug report -- it runs through the same redaction
 * engine as a capture, including the hard rules.
 */
export interface DoctorSourceReport {
  adapter_id: string;
  adapter_version: string;
  found: boolean;
  paths: string[];
  approx_units: number;
  note?: string;
  sampled: {
    unit: string;
    parse_level: 'strict' | 'loose' | 'raw';
    matched_adapter?: string;
    /** Set when a different adapter owns this file (e.g. two exports both
     *  unpack to conversations.json). Not a problem, and not a degradation. */
    handled_by?: string;
    rejected_versions: string[];
    unrecognised_keys: string[];
  }[];
}

export interface DoctorOptions {
  env: LocalEnv;
  adapters: CaptureAdapter[];
  /** Units to inspect per source. Enough to spot a change, cheap to run. */
  sampleSize?: number;
  dumpSampleDir?: string;
  profile: 'medical' | 'general';
  salt: string;
}

function safeSniff(adapter: CaptureAdapter, text: string): boolean {
  try { return adapter.sniff(text); } catch { return false; }
}

export async function doctor(opts: DoctorOptions): Promise<DoctorSourceReport[]> {
  const sampleSize = opts.sampleSize ?? 3;
  const byId = new Map<string, CaptureAdapter[]>();
  for (const a of opts.adapters) byId.set(a.id, [...(byId.get(a.id) ?? []), a]);

  const engine = new RedactionEngine({ profile: opts.profile, salt: opts.salt });
  const reports: DoctorSourceReport[] = [];

  for (const [id, versions] of byId) {
    const primary = versions[0]!;
    const report: DoctorSourceReport = {
      adapter_id: id,
      adapter_version: primary.version,
      found: false,
      paths: [],
      approx_units: 0,
      sampled: [],
    };

    try {
      const d = await primary.detect(opts.env);
      report.found = d.found;
      report.paths = d.paths;
      report.approx_units = d.approxUnits;
      if (d.note) report.note = d.note;
      if (!d.found) { reports.push(report); continue; }

      let n = 0;
      for await (const unit of primary.collect({ env: opts.env, paths: d.paths })) {
        if (n >= sampleSize) break;
        n++;
        const text = await unit.read();
        const sniffed = sniffUnit(text, versions);

        // Which keys are unrecognised depends on who does the parsing. Asking
        // the loose parser about a strictly-parsed file produces a list of
        // keys the real adapter understands perfectly -- alarming and wrong.
        let unrecognised: string[] = [];
        if (sniffed.level === 'strict' && sniffed.adapter) {
          const strict = parseStrict(sniffed.adapter, unit, text);
          const ext = strict.result?.runs[0]?.raw_ext as
            { unknown_record_keys?: string[] } | undefined;
          unrecognised = ext?.unknown_record_keys ?? [];
        } else {
          const loose = parseLoose(unit, text)[0];
          unrecognised = (loose?.raw_ext as { unrecognised_keys?: string[] } | undefined)
            ?.unrecognised_keys ?? [];
        }

        // Mirrors the pipeline: a file another adapter parses strictly is that
        // adapter's, and reporting it as degraded here would be a false alarm.
        const owner = sniffed.level === 'strict'
          ? undefined
          : opts.adapters.find((o) => o.id !== id && safeSniff(o, text));

        report.sampled.push({
          unit: unit.unitId,
          parse_level: sniffed.level,
          ...(sniffed.adapter ? { matched_adapter: adapterKey(sniffed.adapter) } : {}),
          ...(owner ? { handled_by: adapterKey(owner) } : {}),
          rejected_versions: sniffed.rejected,
          unrecognised_keys: unrecognised.slice(0, 40),
        });

        if (opts.dumpSampleDir) {
          // Same redaction path as a real capture: a sample you cannot safely
          // send is a sample nobody sends.
          const safe = engine.redactText(text.slice(0, 200_000)).text;
          const name = `${id}-${n}.sample.txt`;
          await writeFile(join(opts.dumpSampleDir, name), safe, 'utf8');
        }
      }
    } catch (e) {
      report.note = `${report.note ? `${report.note} ` : ''}inspection failed: ${(e as Error).message}`;
    }
    reports.push(report);
  }
  return reports;
}
