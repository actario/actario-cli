import { join } from 'node:path';
import { actarioDir } from '@distill/capture';
import { DistillError } from '@distill/shared';
import { bold, dim, green, heading, red, yellow } from '../print.ts';
import { flagBool, flagString, type Args } from '../args.ts';
import { startDeviceLogin } from '../core/device-login.ts';

/**
 * `actario login` -- link this machine by signing in to Actario in a
 * browser (core/device-login.ts). The terminal twin of the MCP `link` tool
 * called without a token.
 *
 *   --device        no browser, no local port: print a URL and a code to
 *                   approve on any device (SSH sessions, containers)
 *   --no-browser    same as --device (loopback needs a browser opened here)
 *   --api-url URL   --label NAME   --profile medical|general
 */
export async function loginCommand(args: Args): Promise<number> {
  const device = flagBool(args, 'device');
  const profile = flagString(args, 'profile');
  process.stdout.write(heading('Sign in to Actario'));
  let login;
  try {
    login = await startDeviceLogin({
      ...(flagString(args, 'api-url') ? { apiUrl: flagString(args, 'api-url') } : {}),
      clientName: 'Actario CLI',
      ...(flagString(args, 'label') ? { label: flagString(args, 'label') } : {}),
      ...(profile === 'medical' || profile === 'general' ? { profile } : {}),
      ...(device || flagBool(args, 'no-browser') ? { loopback: false, openBrowser: false } : {}),
    });
  } catch (e) {
    process.stderr.write(`${red('Could not start the sign-in.')} ${(e as Error).message}\n`);
    return 1;
  }

  const p = login.prompt;
  if (p.browser_opened) {
    process.stdout.write(`A browser tab should have opened. If it didn't, open this on THIS machine:\n\n  ${bold(p.verification_uri_complete)}\n\n`
      + `${dim(`If approving ends on a "can't connect" page, press Ctrl-C and run ${bold('actario login --device')} instead.`)}\n`);
  } else {
    process.stdout.write(`On any device, open\n\n  ${bold(p.verification_uri)}\n\nand enter the code\n\n  ${bold(p.user_code)}\n\n`);
  }
  process.stdout.write(`${dim(`Check the page shows ${p.user_code}. The code expires in ${Math.round(p.expires_in / 60)} minutes.`)}\n`);
  process.stdout.write(`${dim('Waiting for approval…')}\n`);

  // Ctrl-C mid-wait: stop polling, say so, exit non-zero.
  const onInt = () => login.cancel();
  process.once('SIGINT', onInt);
  try {
    const r = await login.done;
    process.stdout.write(
      `\n${green('Linked')}${r.email ? ` as ${r.email}` : ''} to ${bold(r.workspace_name ?? r.identity.workspace_id ?? 'your workspace')}\n` +
      `  source   ${r.source.id}${'label' in r.source && r.source.label ? dim(`  (${r.source.label}${r.sourceCreated ? ', created' : ''})`) : ''}\n` +
      `  saved    ${dim(join(actarioDir(), 'config.json'))}\n` +
      `${dim('The key is listed under Settings → Access tokens as "Claude · <this machine>"; revoke it there.')}\n`,
    );
    process.stdout.write(heading('Sources on this machine'));
    for (const s of r.sources) {
      const mark = s.found ? green('found') : yellow('not found');
      process.stdout.write(`  ${s.id.padEnd(24)} ${mark}  ${s.found ? dim(`~${s.approxUnits} unit(s)`) : dim(s.note ?? '')}\n`);
    }
    process.stdout.write(`\nNext: ${bold('actario capture --dry-run')} to see what would be uploaded.\n`);
    return 0;
  } catch (e) {
    const err = e as DistillError;
    process.stderr.write(`\n${red(err.code === 'access_denied' ? 'Declined.' : 'Not linked.')} ${err.message}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onInt);
  }
}
