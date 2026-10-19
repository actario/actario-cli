import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig, type Config } from '@distill/capture';
import { homeScope, rootActarioHome } from '@distill/shared';
import { whoami, type ApiOptions } from '../api.ts';

/**
 * One computer, several people (arch v2.1 ch. 22 addendum, CLI 0.1.5).
 *
 * Each Actario account linked on this computer has its own home: the first
 * at ~/.actario (as before), the others at ~/.actario/profiles/<key>/. A home
 * is complete -- token, salt, redaction map, capture state, inbox, bundles,
 * restored runs, memories -- so A's captures upload to A's workspace with
 * A's pseudonyms, and B's to B's, and neither unmasks the other's.
 *
 * Which home a tool call runs in is decided by its pass (the local MCP
 * server's passGuard): the pass names an Actario person and workspace, and
 * the home whose token belongs to them is the one that accepts it.
 *
 * Note what this is and is not: it keeps two people's data apart in normal
 * use of the plugin. It is not a wall between two people sharing one OS
 * login -- anything running as that login can read both homes' files.
 * Separate OS accounts are that wall.
 */

export interface Home {
  dir: string;
  root: boolean;
  config: Config;
}

export const profilesDir = (): string => join(rootActarioHome(), 'profiles');

/** `<user 8>-<workspace 8>`: stable, readable, and not an email on disk. */
export const profileKey = (userId: string, workspaceId: string): string =>
  `${userId.slice(0, 8)}-${workspaceId.slice(0, 8)}-${createHash('sha256').update(`${userId}|${workspaceId}`).digest('hex').slice(0, 6)}`;

export function readConfigIn(dir: string): Config {
  return homeScope.run({ home: dir }, () => readConfig());
}

/** Every home on this computer, the root one first. Homes with no token are listed; callers skip what they cannot use. */
export function listHomes(): Home[] {
  const root = rootActarioHome();
  const out: Home[] = [{ dir: root, root: true, config: readConfigIn(root) }];
  const pd = profilesDir();
  if (existsSync(pd)) {
    for (const name of readdirSync(pd).sort()) {
      const dir = join(pd, name);
      if (!existsSync(join(dir, 'config.json'))) continue;
      try { out.push({ dir, root: false, config: readConfigIn(dir) }); } catch { /* a damaged profile is skipped, not fatal */ }
    }
  }
  return out;
}

export const linkedHomes = (): Home[] => listHomes().filter((h) => h.config.api_url && h.config.token);

export const apiOf = (h: Home): ApiOptions => ({ baseUrl: h.config.api_url!, token: h.config.token! });

/**
 * Where a link for this person and workspace goes:
 *   - the home already linked to them (re-linking replaces its token);
 *   - else ~/.actario if it is not linked to anyone;
 *   - else a new home under profiles/.
 * A home linked before homes had an `identity` is asked who it is (once).
 */
export async function homeForIdentity(userId: string, workspaceId: string): Promise<string> {
  for (const h of listHomes()) {
    const id = h.config.identity ?? (h.config.token && h.config.api_url ? await identityOf(h) : null);
    if (id && id.user_id === userId && id.workspace_id === workspaceId) return h.dir;
  }
  const root = listHomes()[0]!;
  if (!root.config.token) return root.dir;
  return join(profilesDir(), profileKey(userId, workspaceId));
}

async function identityOf(h: Home): Promise<{ user_id: string; workspace_id: string } | null> {
  try {
    const me = await whoami(apiOf(h));
    return me.user_id && me.workspace_id ? { user_id: me.user_id, workspace_id: me.workspace_id } : null;
  } catch {
    // Unreachable or revoked: unknown, so never treated as "the same person".
    return null;
  }
}
