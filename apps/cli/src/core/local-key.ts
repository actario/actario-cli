import { basename } from 'node:path';
import { readConfig, writeConfig } from '@distill/capture';
import { DistillError, homeScope } from '@distill/shared';
import { checkPassApi } from '../api.ts';
import { NotLinkedError } from './restore.ts';
import { apiOf, linkedHomes, listHomes, type Home } from './profiles.ts';

/**
 * Local keys (arch v3.1 23.12, CLI 0.2.2).
 *
 * The plugin answers only a call that carries a pass from the Actario
 * connector of the AI account in use (23.5). For accounts a platform
 * superuser allowed, there is a second door: a LOCAL KEY its person made on
 * the web, saved here in the home of the Actario account it belongs to. The
 * plugin then presents it in place of a pass -- for any AI account on this
 * computer, which is the trade the allowlist exists for.
 *
 * Saving checks the key first, against each linked home's server, as that
 * home's person: it lands in the one home whose person and workspace it
 * opens, or nowhere. A key that opens nothing is never written.
 */
export const LOCAL_KEY_RE = /^actario_lkey_[A-Za-z0-9_-]{32}$/;

const homeName = (h: Home): string => (h.root ? 'default' : basename(h.dir));

const writeKey = (dir: string, key: string | undefined): void =>
  homeScope.run({ home: dir }, () => {
    const cfg = { ...readConfig() };
    if (key === undefined) delete cfg.local_key; else cfg.local_key = key;
    writeConfig(cfg);
  });

export interface SavedLocalKey {
  home: string;
  account: string | null;
  workspace_id: string;
  name: string;
}

export async function saveLocalKey(input: string): Promise<SavedLocalKey> {
  const key = input.trim();
  if (!LOCAL_KEY_RE.test(key)) {
    throw new DistillError('invalid_request', 'That is not an Actario local key (actario_lkey_ followed by 32 characters). Make one under /connections on the web and copy it whole.');
  }
  const homes = linkedHomes();
  if (homes.length === 0) {
    throw new NotLinkedError('This computer is not linked to Actario, so there is nothing to save the key to. Link it first (`actario login`, or the plugin\'s `link`).');
  }
  let unreachable: string | null = null;
  for (const h of homes) {
    try {
      // The save binds the key to this home's machine token: a copy of it opens no other computer.
      const r = await checkPassApi(apiOf(h), key, true);
      writeKey(h.dir, key);
      return { home: homeName(h), account: h.config.identity?.email ?? null, workspace_id: r.workspace_id, name: r.client_name };
    } catch (e) {
      if (e instanceof DistillError && ['forbidden', 'not_found', 'invalid_request', 'unauthorized'].includes(e.code)) continue;
      unreachable = e instanceof Error ? e.message : String(e);
    }
  }
  if (unreachable) throw new DistillError('internal', `Could not check the key (${unreachable}). Nothing was saved; retry when Actario is reachable.`);
  throw new DistillError('forbidden',
    'This key does not open Actario on this computer, so it was not saved. Either it was revoked, your account is no longer allowed local keys, '
    + 'it was made for a workspace this computer is not linked to (make it while that workspace is the active one on the web), '
    + 'or it is already saved on another computer -- a key opens one computer; make another one for this computer.');
}

/** Removes the local key from every home on this computer; the number removed. */
export function removeLocalKeys(): number {
  let n = 0;
  for (const h of listHomes()) {
    if (!h.config.local_key) continue;
    writeKey(h.dir, undefined);
    n += 1;
  }
  return n;
}

/** Which homes hold a key. Never the key. */
export const localKeyStatus = (): { home: string; local_key: boolean }[] =>
  linkedHomes().map((h) => ({ home: homeName(h), local_key: Boolean(h.config.local_key) }));
