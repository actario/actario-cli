import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { actarioDir } from '@distill/capture';
import { DistillError } from '@distill/shared';
import { request, type ApiOptions } from '../api.ts';

/**
 * Weekly reports from this machine (2026-10-18). The server does the
 * assembling and the rendering -- one renderer for every version, so the
 * agent's report and the web's look alike; this side only fetches the week's
 * material for the user's agent to re-tell, saves what it wrote, and
 * downloads the files.
 */
export const reportsDir = (): string => join(actarioDir(), 'reports');
export const REPORT_FORMATS = ['pptx', 'pdf', 'md', 'docx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This machine's time zone: a week is Monday to Sunday where the user is. */
export function localTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** A line by id, or by name (exact first, then the one name that contains it). */
export async function resolveLine(api: ApiOptions, line: string): Promise<{ id: string; name: string }> {
  const ref = line.trim();
  const { agents } = await request<{ agents: { id: string; name: string }[] }>(api, '/api/v1/dashboard', { method: 'GET' });
  if (UUID.test(ref)) {
    const hit = agents.find((a) => a.id.toLowerCase() === ref.toLowerCase());
    return hit ?? { id: ref, name: ref };
  }
  const lower = ref.toLowerCase();
  const exact = agents.filter((a) => a.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const partial = agents.filter((a) => a.name.toLowerCase().includes(lower));
  if (exact.length === 0 && partial.length === 1) return partial[0]!;
  const options = (exact.length ? exact : partial).slice(0, 10).map((a) => ({ id: a.id, name: a.name }));
  throw new DistillError(options.length ? 'conflict' : 'not_found',
    options.length ? `More than one line matches "${ref}"; pass its id.` : `No line matches "${ref}".`,
    options.length ? options : agents.slice(0, 20).map((a) => ({ id: a.id, name: a.name })), options.length ? 409 : 404);
}

const qs = (p: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  return `?${u.toString()}`;
};

export const weeklyPath = (lineId: string, week: string) => `/api/v1/agents/${encodeURIComponent(lineId)}/reports/${encodeURIComponent(week)}`;

export const getWeekly = <T = Record<string, unknown>>(api: ApiOptions, lineId: string, week: string, q: { tz?: string; author?: string; sources?: boolean }) =>
  request<T>(api, `${weeklyPath(lineId, week)}${qs({ tz: q.tz, author: q.author, sources: q.sources ? '1' : undefined })}`, { method: 'GET' });

export const putWeekly = (api: ApiOptions, lineId: string, week: string, body: { report: unknown; model?: string }, tz: string) =>
  request<{ id: string; week: string; url: string }>(api, `${weeklyPath(lineId, week)}${qs({ tz })}`, { method: 'PUT', body: JSON.stringify(body), attempts: 1 });

/** Download the rendered files and write them, never over an existing file. */
export async function downloadWeekly(api: ApiOptions, lineId: string, week: string, opts: {
  author?: string; tz: string; formats: readonly ReportFormat[]; dir?: string;
}): Promise<{ files: { format: ReportFormat; path: string; bytes: number }[]; refused: { format: ReportFormat; reason: string }[] }> {
  if (opts.dir && !isAbsolute(opts.dir)) throw new DistillError('invalid_request', '`dir` must be an absolute path to an existing folder.', undefined, 400);
  const dir = opts.dir ? resolve(opts.dir) : reportsDir();
  if (opts.dir && !existsSync(dir)) throw new DistillError('invalid_request', `No such folder: ${dir}`, undefined, 400);
  mkdirSync(dir, { recursive: true });
  const files: { format: ReportFormat; path: string; bytes: number }[] = [];
  const refused: { format: ReportFormat; reason: string }[] = [];
  for (const format of opts.formats) {
    const url = new URL(`${weeklyPath(lineId, week)}${qs({ tz: opts.tz, author: opts.author, format })}`, api.baseUrl);
    const res = await fetch(url, { headers: { authorization: `Bearer ${api.token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
      refused.push({ format, reason: body.error?.message ?? `${res.status} ${res.statusText}` });
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get('content-disposition') ?? '';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    let decoded: string | null = null;
    if (utf8) { try { decoded = decodeURIComponent(utf8); } catch { decoded = null; } }
    const name = (decoded ?? `weekly-${week}.${format}`).replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ');
    const stem = name.replace(/\.[^.]+$/, '');
    let written = false;
    for (let n = 1; n < 1000 && !written; n++) {
      const path = join(dir, n === 1 ? `${stem}.${format}` : `${stem}-${n}.${format}`);
      try {
        writeFileSync(path, buf, { flag: 'wx' });   // never replace, never follow a symlink
        files.push({ format, path, bytes: buf.length });
        written = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    if (!written) refused.push({ format, reason: `Too many files named ${stem} in ${dir}` });
  }
  return { files, refused };
}
