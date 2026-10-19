import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The machine-local coordinates, renamed DISTILL_* -> ACTARIO_* on the day the
 * CLI first went to npm (arch v1.5 unresolved #5).
 *
 * The old names still work. A machine linked before the rename has them in a
 * shell profile or a scheduled task, and a CLI that silently ignored them
 * would look like it had lost the token rather than like it had been renamed.
 * The old name is read only when the new one is unset, and says so once.
 *
 * On stderr, never stdout: `actario mcp` speaks JSON-RPC on stdout and one
 * stray line there is a protocol error, not a cosmetic one.
 *
 * Deliberately NOT renamed: DISTILL_ROLE and DISTILL_ALLOW_PLATFORM_KEY. Those
 * are set on the deployment, not on a user's machine, and @distill/db-admin
 * refuses to load when DISTILL_ROLE is not 'worker' -- renaming the read
 * without redeploying turns that guard into an outage.
 */
const warned = new Set<string>();

export function actarioEnv(suffix: string): string | undefined {
  const current = process.env[`ACTARIO_${suffix}`];
  if (current !== undefined) return current;
  const legacy = process.env[`DISTILL_${suffix}`];
  if (legacy === undefined) return undefined;
  if (!warned.has(suffix)) {
    warned.add(suffix);
    console.error(`actario: DISTILL_${suffix} is deprecated -- rename it to ACTARIO_${suffix}.`);
  }
  return legacy;
}

let renameReported = false;

/**
 * Resolve the state directory under an explicit home, migrating the pre-rename
 * one if it is still there.
 *
 * Everything the CLI keeps locally lives in this directory: config, upload
 * high-water marks, the pseudonym salt, the encrypted redaction map. The salt
 * in particular cannot be regenerated -- new captures would stop linking to
 * old ones -- so this moves the directory rather than starting a fresh one
 * beside it.
 *
 * If the move fails (a file held open on Windows, a different volume) the old
 * directory is used as-is. A working CLI on the old path beats a CLI that
 * appears to have forgotten who the user is.
 */
export function resolveActarioHome(home: string): string {
  const target = join(home, '.actario');
  if (existsSync(target)) return target;
  const legacy = join(home, '.distill');
  if (!existsSync(legacy)) return target;
  try {
    renameSync(legacy, target);
    console.error('actario: moved ~/.distill to ~/.actario. Config, state and the pseudonym salt came with it; nothing was uploaded.');
    return target;
  } catch (err) {
    if (!renameReported) {
      renameReported = true;
      console.error(`actario: could not move ~/.distill to ~/.actario (${(err as Error).message}); still using ~/.distill.`);
    }
    return legacy;
  }
}

/**
 * One Actario account's local home, for the length of one call.
 *
 * A computer shared by several people (each with their own Claude account
 * and Actario account) keeps one home per Actario account: the first one
 * linked at ~/.actario, the others under ~/.actario/profiles/<key>/. Each is
 * a whole home -- config and token, salt and redaction map, capture state,
 * inbox, bundles, restored runs, memories -- so nothing of one person's is
 * read, written, uploaded or unmasked under the other's. The local MCP
 * server picks the home for each tool call from the pass that call carries
 * and runs the call inside this scope; everything below that asks
 * `actarioHome()` gets that person's home.
 */
export const homeScope = new AsyncLocalStorage<{ home: string | null }>();

/** The machine's first home: ~/.actario, or ACTARIO_HOME when set. Ignores any scope. */
export function rootActarioHome(): string {
  return actarioEnv('HOME') ?? resolveActarioHome(homedir());
}

/** The home of the call in progress (homeScope), else ~/.actario / ACTARIO_HOME. */
export function actarioHome(): string {
  return homeScope.getStore()?.home ?? rootActarioHome();
}
