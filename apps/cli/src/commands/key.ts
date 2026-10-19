import { createInterface } from 'node:readline/promises';
import { type Args, flagBool } from '../args.ts';
import { localKeyStatus, removeLocalKeys, saveLocalKey } from '../core/local-key.ts';
import { bold, dim, green, red } from '../print.ts';

/**
 * `actario key set|remove|status` -- this computer's Actario local key
 * (arch v3.1 23.12; allowlisted accounts). The key is made under
 * /connections on the web; saved here, it lets the plugin answer without a
 * connector pass -- for any AI account on this computer.
 *
 * `set` reads the key from a prompt (or stdin with --stdin), not from the
 * command line, so it stays out of shell history. A key given as an argument
 * is accepted, with a warning.
 */
export async function keyCommand(args: Args): Promise<number> {
  const sub = args.positional[0] ?? 'status';
  if (sub === 'status') {
    const rows = localKeyStatus();
    if (rows.length === 0) { process.stdout.write('This computer is not linked to Actario.\n'); return 3; }
    for (const r of rows) process.stdout.write(`  ${r.home}  ${r.local_key ? green('local key saved') : dim('no local key')}\n`);
    return 0;
  }
  if (sub === 'remove') {
    const n = removeLocalKeys();
    process.stdout.write(n ? `${green('Removed')} from this computer. It stays valid wherever else it was saved until you revoke it under /connections.\n` : 'This computer had no local key.\n');
    return 0;
  }
  if (sub !== 'set') {
    process.stderr.write(`${red('Usage:')} actario key set [--stdin] | remove | status\n`);
    return 1;
  }
  let key = args.positional[1];
  if (key) process.stderr.write(`${dim('Note: a key typed on the command line can end up in your shell history. Next time run')} ${bold('actario key set')} ${dim('and paste it at the prompt.')}\n`);
  if (!key && (flagBool(args, 'stdin') || !process.stdin.isTTY)) {
    let raw = '';
    for await (const chunk of process.stdin) raw += String(chunk);
    key = raw.trim();
  }
  if (!key) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { key = (await rl.question('Paste the local key from /connections (actario_lkey_…): ')).trim(); } finally { rl.close(); }
  }
  const saved = await saveLocalKey(key);
  process.stdout.write(`${green('Saved')} for ${bold(saved.account ?? saved.home)} (${saved.name}). `
    + 'The Actario plugin on this computer now answers without a connector -- for any AI account here. Revoke it under /connections when you stop using it.\n');
  return 0;
}
