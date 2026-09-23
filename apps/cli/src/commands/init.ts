import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { actarioDir, readConfig } from '@distill/capture';
import { DistillError } from '@distill/shared';
import { bold, dim, green, heading, red, yellow } from '../print.ts';
import { flagString, type Args } from '../args.ts';
import { linkMachine } from '../core/link.ts';
import { loginCommand } from './login.ts';

/**
 * `actario init` -- one of only two places where the CLI is allowed to ask
 * questions (5.2). Everything it asks for can also be passed as a flag, so
 * this is scriptable and CI-friendly.
 *
 * The work is core/link.ts, shared with the MCP `link` tool. Two things
 * changed when it moved there: the token is validated against the server
 * before anything is written, and the source id is no longer asked for --
 * the server finds or creates one for this machine. `--source-id` still
 * works for the rare case of pointing a machine at a source made elsewhere.
 */
export async function initCommand(args: Args): Promise<number> {
  const cfg = readConfig();
  const interactive = process.stdin.isTTY && !flagString(args, 'token');
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, fallback?: string): Promise<string | undefined> => {
    if (!rl) return fallback;
    const a = (await rl.question(`${q}${fallback ? dim(` [${fallback}]`) : ''}: `)).trim();
    return a || fallback;
  };

  try {
    process.stdout.write(heading('Actario setup'));
    const apiUrl = flagString(args, 'api-url') ?? await ask('API URL', cfg.api_url ?? 'http://localhost:3000');
    const token = flagString(args, 'token') ?? await ask('Capture token (empty = sign in with the browser instead)', cfg.token);
    const profile = (flagString(args, 'profile') ?? await ask('Redaction profile (medical|general)', cfg.redaction_profile)) as 'medical' | 'general' | undefined;
    if (apiUrl && !token && interactive) {
      // No token to paste: that is what `actario login` is for.
      rl?.close();
      return loginCommand({ ...args, flags: { ...args.flags, 'api-url': apiUrl, ...(profile ? { profile } : {}) } });
    }
    if (!apiUrl || !token) {
      process.stderr.write(`${red('Both an API URL and a token are needed.')} Or run ${bold('actario login')} to sign in with the browser.\n`);
      return 1;
    }

    let r;
    try {
      r = await linkMachine({
        apiUrl, token,
        ...(flagString(args, 'source-id') ? { sourceId: flagString(args, 'source-id') } : {}),
        ...(flagString(args, 'label') ? { label: flagString(args, 'label') } : {}),
        ...(profile === 'medical' ? { profile: 'medical' as const } : profile === 'general' ? { profile: 'general' as const } : {}),
      });
    } catch (e) {
      const err = e as DistillError;
      if (err.code === 'unauthorized') {
        process.stderr.write(`${red('The server did not accept that token.')} Nothing was written. Check it was copied whole.\n`);
        return 1;
      }
      if (err.code === 'forbidden') {
        process.stderr.write(`${red('That token cannot capture.')} ${err.message}\nNothing was written.\n`);
        return 1;
      }
      if (err.code === 'internal' && /failed/i.test(err.message)) {
        process.stderr.write(`${red('Could not reach the API')} at ${apiUrl}: ${err.message}\nNothing was written.\n`);
        return 1;
      }
      throw e;
    }

    const dir = actarioDir();
    process.stdout.write(
      `\n${green('Linked')} as ${dim(r.identity.user_id ?? 'user')} to workspace ${dim(r.identity.workspace_id ?? '(first membership)')}\n` +
      `  source   ${r.source.id}${'label' in r.source && r.source.label ? dim(`  (${r.source.label}${r.sourceCreated ? ', created' : ''})`) : ''}\n` +
      `  saved    ${dim(join(dir, 'config.json'))}\n` +
      `${dim(`Pseudonym salt at ${join(dir, 'salt')} -- never uploaded, back it up if you care about cross-capture linking.`)}\n`,
    );

    process.stdout.write(heading('Sources on this machine'));
    for (const s of r.sources) {
      const mark = s.found ? green('found') : yellow('not found');
      process.stdout.write(`  ${s.id.padEnd(24)} ${mark}  ${s.found ? dim(`~${s.approxUnits} unit(s)`) : dim(s.note ?? '')}\n`);
    }
    process.stdout.write(`\nNext: ${bold('actario capture --dry-run')} to see what would be uploaded.\n`);
    return 0;
  } finally {
    rl?.close();
  }
}
