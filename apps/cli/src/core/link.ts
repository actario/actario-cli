import { hostname } from 'node:os';
import { join } from 'node:path';
import { allAdapters } from '@distill/adapters';
import { actarioDir, localEnv, readConfig, writeConfig, zConfig, type Config } from '@distill/capture';
import { ensureSalt } from '@distill/redaction';
import { DistillError, homeScope, type MeResponse, type SourceDto } from '@distill/shared';
import { homeForIdentity, listHomes } from './profiles.ts';
import { createSource, listSources, patchSource, whoami, type ApiOptions } from '../api.ts';

/**
 * Linking a machine to a workspace, as one function (5.2's "the only place
 * the CLI may ask questions" -- except here nobody is asked).
 *
 * `actario init` used to write whatever it was given and let the first
 * capture find out an hour later, from cron, that the token was wrong. In a
 * chat window that is not survivable: the person pasted a token thirty
 * seconds ago and the answer has to come back now. So this validates the
 * token first (GET /api/v1/me), refuses one that cannot capture, and only
 * then writes config.
 *
 * The source id -- the UUID `init` used to demand and nobody could obtain --
 * is found or created on the server: one source per (user, label), label
 * defaulting to the hostname, so a workspace with three laptops can tell them
 * apart and re-linking the same laptop does not mint a second one.
 */
export interface LinkOptions {
  apiUrl: string;
  token: string;
  /** Use an existing source instead of finding/creating one by label. */
  sourceId?: string;
  label?: string;
  profile?: 'general' | 'medical';
}

export interface LinkResult {
  config: Config;
  /** The home this link went to: ~/.actario, or a profile for a second person on this computer. */
  home: string;
  /** True when this computer already had someone else linked and this person got a home of their own. */
  newProfile: boolean;
  identity: MeResponse;
  source: SourceDto | { id: string; label: string | null; created: false };
  sourceCreated: boolean;
  sources: { id: string; found: boolean; approxUnits?: number; note?: string }[];
}

export async function linkMachine(opts: LinkOptions): Promise<LinkResult> {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(apiUrl)) throw new DistillError('invalid_request', 'api_url must start with http:// or https://');
  const api: ApiOptions = { baseUrl: apiUrl, token: opts.token };

  const identity = await whoami(api);
  if (identity.kind !== 'user') {
    throw new DistillError('forbidden',
      'This is an agent token. Capture and analysis are writes, and agents never write (arch 10.2); link with a token minted for yourself.');
  }
  if (!identity.can_capture) {
    throw new DistillError('forbidden',
      `This token does not carry the "capture" scope (it has: ${identity.scopes.join(', ') || 'none'}). Mint one with capture scope.`);
  }

  if (!identity.user_id || !identity.workspace_id) throw new DistillError('forbidden', 'This token is not bound to a person and a workspace; mint one from Settings → Access tokens.');
  // One home per Actario person and workspace on this computer (profiles.ts):
  // a second person linking does not replace the first one's link.
  const home = await homeForIdentity(identity.user_id!, identity.workspace_id!);
  const newProfile = home !== listHomes()[0]!.dir && !listHomes().some((h) => h.dir === home);
  return homeScope.run({ home }, () => linkInto(opts, apiUrl, api, identity, home, newProfile));
}

async function linkInto(opts: LinkOptions, apiUrl: string, api: ApiOptions, identity: MeResponse, home: string, newProfile: boolean): Promise<LinkResult> {
  let source: LinkResult['source'];
  let sourceCreated = false;
  if (opts.sourceId) {
    source = { id: opts.sourceId, label: null, created: false };
  } else {
    const label = opts.label ?? hostname();
    const existing = (await listSources(api)).sources.find((s) => s.label === label);
    if (existing) {
      // Re-linking with `medical` must reach the server row, not just the
      // local config: corpus_eligible is derived from the source's profile
      // there, and the promise "excluded from the corpus for good" is made
      // about that column. One-way, like the API.
      source = opts.profile === 'medical' && existing.profile !== 'medical'
        ? await patchSource(api, existing.id, { profile: 'medical' })
        : existing;
    } else {
      source = await createSource(api, { platform: 'local', capture_method: 'local_file', label, profile: opts.profile ?? 'general' });
      sourceCreated = true;
    }
  }

  const prev = readConfig();
  const config = zConfig.parse({
    ...prev,
    api_url: apiUrl,
    token: opts.token,
    source_id: source.id,
    redaction_profile: opts.profile ?? prev.redaction_profile ?? 'general',
    identity: { user_id: identity.user_id!, workspace_id: identity.workspace_id!, email: prev.identity?.email ?? null },
  });
  writeConfig(config);
  // Created once and never rotated: the salt is what makes the same person
  // resolve to the same pseudonym across months of captures (6.5).
  ensureSalt(actarioDir());

  const env = localEnv(config.extra_paths);
  const seen = new Set<string>();
  const sources: LinkResult['sources'] = [];
  for (const a of await allAdapters(join(actarioDir(), 'adapters'))) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const d = await a.detect(env);
    sources.push({ id: a.id, found: d.found, ...(d.found ? { approxUnits: d.approxUnits } : {}), ...(d.note ? { note: d.note } : {}) });
  }
  return { config, home, newProfile, identity, source, sourceCreated, sources };
}
