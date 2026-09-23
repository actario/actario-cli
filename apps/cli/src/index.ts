import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DistillError } from '@distill/shared';
import { parseArgs } from './args.ts';
import { CLI_VERSION } from './version.ts';
import { bold, dim, heading, red } from './print.ts';
import { analyzeCommand } from './commands/analyze.ts';
import { captureCommand } from './commands/capture.ts';
import { doctorCommand } from './commands/doctor.ts';
import { initCommand } from './commands/init.ts';
import { loginCommand } from './commands/login.ts';
import { mcpCommand } from './commands/mcp.ts';
import { resetStateCommand } from './commands/reset-state.ts';
import { statusCommand } from './commands/status.ts';
import { unmaskCommand } from './commands/unmask.ts';

const USAGE = `${bold('actario')} ${dim(`v${CLI_VERSION}`)}

  actario capture [options]     capture, redact and upload new sessions
  actario analyze [options]     analyse the captured batch here, on your own subscription
                               ${dim('(separate from capture on purpose: a model failure never costs a capture)')}
  actario status [upload_id]    local capture state, or one upload's progress
  actario doctor [--schema]     diagnose sources and report format changes
  actario login [options]       link this machine by signing in with the browser
  actario init [options]        link this machine with a pasted token
  actario reset-state          forget the high-water mark and re-read everything
                               ${dim('(needed after resetting a development database)')}
  actario unmask <zip|dir>     reverse pseudonyms in a downloaded export, locally
                               ${dim('(uses this machine\'s redaction map; never the server)')}
  actario mcp                  serve capture / analyze as MCP tools over stdio
                               ${dim('(the capture front door for agents without a shell; not the read-only reflow MCP)')}

${bold('capture options')}
  --since 90d|2026-01-01   only sessions newer than this
  --sources a,b            limit to these adapter ids
  --dry-run                build the report, upload nothing, change no state
  --no-redact              disable personal-data rules for this run
  --no-diffs               do not upload artifact diff bodies (v1.2 default: upload)
                           ${dim('(credential rules stay on and cannot be disabled)')}

${bold('analyze options')}
  --bundle ID              an older batch (bundle or upload id, prefix ok); a full upload id
                           is fetched through the export when it is not on this machine
  --daf PATH               validate this DAF against the bundle and upload it
  --out DIR                write the readable runs here instead of ~/.actario/analysis/<bundle>
                           ${dim('(without --daf: writes the runs as readable JSON and says where the DAF goes)')}
  --json                   machine-readable index of the prepared runs
  --no-wait                do not wait for the server's verdict
  --force                  send even if every anchor fails the local check

${bold('doctor options')}
  --schema                 print the actual structure of the session files
                           ${dim('(key names and counts only -- no content)')}
  --files N                limit --schema to N files per source
  --dump-sample            write a de-identified sample for a bug report

${bold('init options')}
  --api-url URL  --token TOKEN  --profile medical|general  --label NAME
                           ${dim('the token is validated first; this machine is registered as a source (--source-id to reuse one)')}

${bold('login options')}
  --device                 no browser: print a URL + code to approve on any device
  --no-browser             same as --device
  --api-url URL  --label NAME  --profile medical|general

${bold('unmask options')}
  --out DIR                write here instead of <name>.unmasked/ next to the input

Config, state and the pseudonym salt live in ~/.actario (override: ACTARIO_HOME).
`;

/**
 * Flush, then exit.
 *
 * `process.exit()` discards whatever is still sitting in the stdout buffer.
 * On Linux, writes to a TTY are synchronous so the buffer is always empty and
 * the bug is invisible; on Windows -- and anywhere stdout is a pipe, which
 * includes `npm run` -- writes are asynchronous and the entire report is
 * silently thrown away. The CLI printed nothing at all.
 *
 * `stream.write('', cb)` fires its callback once the stream has drained, so
 * this waits for the real flush rather than guessing with a timer. The exit
 * code still has to be an exit code: this runs from cron and from shell
 * aliases, where "did it work" must be answerable without parsing stdout.
 *   0 ok   1 error   2 capture quality rejected   3 not configured
 */
const flush = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => { stream.write('', () => resolve()); });

async function exitWith(code: number): Promise<never> {
  process.exitCode = code;
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  // The one sanctioned exit, reached only after both streams have drained.
  // eslint-disable-next-line no-restricted-syntax
  process.exit(code);
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.flags.version || args.command === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return exitWith(0);
  }
  if (args.command === 'help' || args.flags.help) {
    process.stdout.write(USAGE);
    return exitWith(0);
  }

  const commands: Record<string, () => Promise<number>> = {
    capture: () => captureCommand(args),
    analyze: () => analyzeCommand(args),
    status: () => statusCommand(args),
    doctor: () => doctorCommand(args),
    init: () => initCommand(args),
    login: () => loginCommand(args),
    'reset-state': () => resetStateCommand(args),
    unmask: () => unmaskCommand(args),
    mcp: () => mcpCommand(args),
  };

  const run = commands[args.command];
  if (!run) {
    process.stderr.write(`${red(`Unknown command: ${args.command}`)}\n${USAGE}`);
    return exitWith(1);
  }

  try {
    return await exitWith(await run());
  } catch (e) {
    if (e instanceof DistillError) {
      process.stderr.write(`${red(`${e.code}:`)} ${e.message}\n`);
      if (e.details) process.stderr.write(`${dim(JSON.stringify(e.details))}\n`);
      return exitWith(1);
    }
    process.stderr.write(`${heading(red('Unexpected error'))}${(e as Error).stack ?? String(e)}\n`);
    return exitWith(1);
  }
}

/**
 * Run when this file is the entry point.
 *
 * Without this guard, `node apps/cli/src/index.ts capture` imports the module,
 * calls nothing, and exits 0 -- silently. It looks exactly like a CLI that ran
 * and had nothing to say, which is the worst possible failure shape for the
 * one tool that has to be frictionless (R17). The npm scripts shipped pointing
 * here rather than at bin/actario.js and did precisely that.
 *
 * `bin/actario.js` imports this module and calls main() itself, so argv[1] is
 * the bin script there and this does not fire twice.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  await main(process.argv.slice(2));
}
