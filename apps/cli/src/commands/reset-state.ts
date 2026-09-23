import { join } from 'node:path';
import { actarioDir, readState, writeState } from '@distill/capture';
import { freshness } from '@distill/shared';
import { bold, dim, green, heading, yellow } from '../print.ts';
import { flagList, type Args } from '../args.ts';

/**
 * `actario reset-state` -- forget the high-water mark.
 *
 * Needed the first time anyone resets a development database, which is a thing
 * that happens constantly. The CLI advances its mark only after a confirmed
 * upload (6.1 step 9), so after `supabase db reset` the local state believes
 * every run is already uploaded while the database has nothing -- and the next
 * `actario capture` cheerfully reports zero new sessions. Correct behaviour
 * against a server that no longer exists.
 *
 * Safe by construction: the server deduplicates on `content_hash`, so
 * re-uploading costs a dedupe and never a duplicate row. That asymmetry is
 * what makes forgetting the cursor the cheap operation and losing data the
 * expensive one.
 */
export async function resetStateCommand(args: Args): Promise<number> {
  const sources = flagList(args, 'sources');
  const state = readState();
  const entries = Object.entries(state.sources);

  if (entries.length === 0) {
    process.stdout.write(`${heading('Capture state')}  ${dim('Already empty; nothing to forget.')}\n`);
    return 0;
  }

  const targets = sources.length > 0
    ? entries.filter(([key]) => sources.some((s) => key.startsWith(s)))
    : entries;

  if (targets.length === 0) {
    process.stdout.write(
      `${heading('Capture state')}  ${yellow('No source matched.')} Known sources:\n` +
      entries.map(([k]) => `    ${k}\n`).join(''),
    );
    return 1;
  }

  process.stdout.write(heading('Forgetting'));
  for (const [key, s] of targets) {
    const f = freshness(s.last_seen_at);
    process.stdout.write(
      `  ${key.padEnd(34)} ${dim(`${s.uploaded_hashes.length} run(s) known, up to ` +
        `${f.coverage_end ? f.coverage_end.slice(0, 10) : 'never'}`)}\n`,
    );
    delete state.sources[key];
  }

  writeState(state);

  process.stdout.write(
    `\n${green('Done.')} The next ${bold('actario capture')} will re-read everything from these sources.\n` +
    `${dim('The server deduplicates by content hash, so nothing is uploaded twice.')}\n` +
    `${dim(`State file: ${join(actarioDir(), 'state.json')}`)}\n`,
  );
  return 0;
}
