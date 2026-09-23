import { readConfig, readState } from '@distill/capture';
import { actarioEnv, freshness } from '@distill/shared';
import { bold, dim, green, heading, red, yellow } from '../print.ts';
import { type Args } from '../args.ts';
import { getUpload } from '../api.ts';

/** `actario status [upload_id]` -- local capture state, or one upload's progress. */
export async function statusCommand(args: Args): Promise<number> {
  const cfg = readConfig();
  const uploadId = args.positional[0];

  if (uploadId) {
    const apiUrl = cfg.api_url ?? actarioEnv('API_URL');
    const token = cfg.token ?? actarioEnv('TOKEN');
    if (!apiUrl || !token) {
      process.stderr.write(`${red('Not linked.')} Run ${bold('actario init')} first.\n`);
      return 3;
    }
    const u = await getUpload({ baseUrl: apiUrl, token }, uploadId);
    const colour = u.status === 'completed' ? green : u.status === 'failed' ? red : yellow;
    process.stdout.write(heading(`Upload ${u.upload_id}`));
    process.stdout.write(`  status  ${colour(u.status)}${u.error_code ? red(`  (${u.error_code})`) : ''}\n`);
    if (u.quality_score != null) process.stdout.write(`  quality ${u.quality_score}/100 ${dim(u.cqs_version ?? '')}\n`);
    if (u.runs_ingested != null) process.stdout.write(`  runs    ${u.runs_ingested} ingested\n`);
    // 'partial' is a real outcome, not an error: some runs were dropped and
    // the rest went through (C5). The list is what makes it actionable.
    for (const d of u.dropped_runs) {
      process.stdout.write(`  ${yellow('dropped')} ${d.run_ref} ${dim(d.reason)}\n`);
    }
    return u.status === 'failed' ? 1 : 0;
  }

  const state = readState();
  process.stdout.write(heading('Local capture state'));
  const entries = Object.entries(state.sources);
  if (entries.length === 0) {
    process.stdout.write(`  ${dim('Nothing captured yet from this machine.')}\n`);
    return 0;
  }
  for (const [key, s] of entries) {
    const f = freshness(s.last_seen_at);
    const age = f.data_age_days == null ? 'never' : `${f.data_age_days}d ago`;
    process.stdout.write(
      `  ${key.padEnd(34)} ${f.stale ? yellow(age) : green(age)}  ${dim(`${s.uploaded_hashes.length} run(s) known`)}\n`,
    );
  }
  // Same 7-day rule the dashboard uses, so the two never disagree (8.5).
  if (entries.some(([, s]) => freshness(s.last_seen_at).stale)) {
    process.stdout.write(`\n  ${yellow('Some sources are more than 7 days old.')} Run ${bold('actario capture')} to refresh.\n`);
  }
  return 0;
}
