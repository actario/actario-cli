export const nowIso = (): string => new Date().toISOString();

/** Accepts the loose date shapes L2 parsing finds in the wild (6.3). */
export function parseLooseDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // Heuristic: 10 digits = seconds, 13 = milliseconds. Anything before 2001
    // or more than a year ahead is treated as not-a-timestamp.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    return year >= 2001 && year <= new Date().getUTCFullYear() + 1 ? d : null;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== '') return parseLooseDate(n);
  }
  return null;
}

export const daysBetween = (a: Date, b: Date): number =>
  Math.abs(a.getTime() - b.getTime()) / 86_400_000;

/** `--since 90d` / `--since 2026-01-01`. */
export function parseSince(spec: string, from = new Date()): Date {
  const rel = /^(\d+)([dwmy])$/.exec(spec.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
    return new Date(from.getTime() - days * 86_400_000);
  }
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) throw new Error(`Cannot parse --since value: ${spec}`);
  return d;
}

/** "資料截至 ... (3 days ago)" needs the age, and >7d flips the stale flag (8.5). */
export function freshness(coverageEnd: string | Date | null, now = new Date()) {
  if (!coverageEnd) return { coverage_end: null, data_age_days: null, stale: true };
  const end = typeof coverageEnd === 'string' ? new Date(coverageEnd) : coverageEnd;
  const age = daysBetween(now, end);
  return {
    coverage_end: end.toISOString(),
    data_age_days: Math.floor(age),
    stale: age > 7,
  };
}
