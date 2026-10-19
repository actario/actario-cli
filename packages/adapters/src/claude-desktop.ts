import { join } from 'node:path';
import type {
  AdapterCapabilities, AdapterResult, CaptureAdapter, CollectOpts, DetectResult, LocalEnv, RawUnit,
} from './types.ts';
import { exists } from './util.ts';

/**
 * Claude Desktop local data (channel C).
 *
 * Detection only, deliberately. The desktop app keeps history in a LevelDB
 * store that is locked while the app runs and whose layout is an internal
 * detail with no compatibility promise -- exactly the class of source R13
 * warns about, and the one where a wrong guess produces silently truncated
 * history rather than a visible failure.
 *
 * So this adapter reports what it sees and routes the user to the account
 * export, which covers the same conversations with a stable schema. It stays
 * registered (rather than deleted) because `actario doctor` should say
 * something useful about a source the user can see on their own disk.
 */
const CAPABILITIES: AdapterCapabilities = {
  hasTurnTimestamps: true,
  hasToolCalls: false,
  hasArtifacts: false,
  hasBranches: false,
  hasOutcome: false,
};

function storeDirs(env: LocalEnv): string[] {
  const home = env.homedir;
  if (env.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Claude', 'Local Storage', 'leveldb')];
  }
  if (env.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'Local Storage', 'leveldb')];
  }
  return [join(home, '.config', 'Claude', 'Local Storage', 'leveldb')];
}

export const claudeDesktopLocal: CaptureAdapter = {
  id: 'claude_desktop_local',
  version: '2026-09-detect-only',
  capabilities: CAPABILITIES,

  async detect(env: LocalEnv): Promise<DetectResult> {
    const dirs: string[] = [];
    for (const d of storeDirs(env)) if (await exists(d)) dirs.push(d);
    return {
      found: false, // never contributes runs in M1
      paths: dirs,
      approxUnits: 0,
      note: dirs.length > 0
        ? 'Claude Desktop data found on this machine, but reading it is not enabled: the store is locked while the app runs and its layout carries no compatibility promise. Use Settings -> Privacy -> Export data instead; the claude_export adapter picks the zip up from Downloads automatically.'
        : 'Claude Desktop does not appear to be installed.',
    };
  },

  async *collect(_opts: CollectOpts): AsyncIterable<RawUnit> {
    // Intentionally empty: see detect().
  },

  sniff(): boolean {
    return false;
  },

  toUCF(_unit: RawUnit, _text: string): AdapterResult {
    return { runs: [], agents: [] };
  },
};
