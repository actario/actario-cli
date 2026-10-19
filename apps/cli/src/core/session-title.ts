import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The title of the conversation this agent is in -- the one the app shows
 * in its sidebar -- so a message carries it without the agent having to
 * write one (Jacky, 10-28: "不要設定這個參數，直接帶入 session 的 title").
 *
 * Claude Code, and Cowork on this computer (Claude Code underneath), write
 * each session to `<home>/projects/<project>/<session id>.jsonl`, and the
 * title into it as records: `custom-title` (the person renamed it),
 * `ai-title` (the app named it), or `summary` (older versions). The person's
 * own name wins.
 *
 * Which session is this one? The MCP server cannot ask. But the app writes
 * the agent's turn -- the tool call itself -- to the session file before the
 * tool runs, so the session that called send_message / reply with exactly
 * this body is the one. That holds with several sessions open at once (the
 * same folder, the same line). When no recent file has the call:
 * `CLAUDE_CODE_SESSION_ID`, when the app passed it. Otherwise no title, and
 * the web shows the line name, as before.
 *
 * Local only: nothing here leaves the machine but the title, which is masked
 * with the rest of the body.
 */

const RECENT_MS = 15 * 60_000;
const MAX_FILES = 40;
const TAIL_BYTES = 1 << 20;
const MAX_FULL_BYTES = 64 << 20;

export interface CallProbe {
  /** The tool the agent called: its name ends with this (`mcp__…__send_message`). */
  tool: 'send_message' | 'reply';
  /** The `body` it passed: matched exactly. */
  body: string;
}

/** Where Claude Code homes keep their `projects/`: CLAUDE_CONFIG_DIR, ~/.claude, and Cowork's own homes under the desktop app's data. */
export function projectRoots(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string[] {
  const roots = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR) roots.add(join(env.CLAUDE_CONFIG_DIR, 'projects'));
  roots.add(join(home, '.claude', 'projects'));
  const appData = platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config');
  findClaudeHomes(join(appData, 'Claude', 'local-agent-mode-sessions'), 6, roots);
  return [...roots].filter((r) => existsSync(r));
}

/** `.claude/projects` folders under `dir`, at most `depth` levels down, at most 3000 folders looked at. */
function findClaudeHomes(dir: string, depth: number, out: Set<string>): void {
  let budget = 3000;
  const walk = (d: string, left: number) => {
    if (left < 0 || budget-- <= 0) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      if (e.name === '.claude') { const pr = join(p, 'projects'); if (existsSync(pr)) out.add(pr); continue; }
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, left - 1);
    }
  };
  walk(dir, depth);
}

/** Session files written to in the last 15 minutes, newest first. */
export function recentSessions(roots: string[], now = Date.now()): string[] {
  const found: { path: string; at: number }[] = [];
  for (const root of roots) {
    let projects: string[];
    try { projects = readdirSync(root); } catch { continue; }
    for (const p of projects) {
      let files: string[];
      try { files = readdirSync(join(root, p)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const path = join(root, p, f);
        try {
          const at = statSync(path).mtimeMs;
          if (now - at <= RECENT_MS) found.push({ path, at });
        } catch { /* gone */ }
      }
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, MAX_FILES).map((x) => x.path);
}

function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // a partial first line is not JSON; drop it
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const lines = (text: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l) as Record<string, unknown>); } catch { /* not a record */ }
  }
  return out;
};

/** The title records say: the person's rename, else the app's, else an old summary. */
export function titleIn(text: string): string | null {
  let custom: string | null = null; let ai: string | null = null; let summary: string | null = null;
  for (const r of lines(text)) {
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    if (r.type === 'custom-title') custom = s(r.customTitle) ?? s(r.title) ?? custom;
    else if (r.type === 'ai-title') ai = s(r.aiTitle) ?? s(r.title) ?? ai;
    else if (r.type === 'summary') summary = s(r.summary) ?? summary;
  }
  return custom ?? ai ?? summary;
}

/** Does this session's text hold the agent's call to `probe.tool` with exactly this body? */
export function holdsCall(text: string, probe: CallProbe): boolean {
  if (!text.includes(probe.tool)) return false;
  for (const r of lines(text)) {
    if (r.type !== 'assistant') continue;
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as { type?: string; name?: string; input?: { body?: unknown } }[]) {
      if (c.type === 'tool_use' && typeof c.name === 'string'
          && (c.name === probe.tool || c.name.endsWith(`__${probe.tool}`)) && c.input?.body === probe.body) return true;
    }
  }
  return false;
}

function titleOfFile(path: string): string | null {
  try {
    const tail = titleIn(readTail(path, TAIL_BYTES));
    if (tail) return tail;
    return statSync(path).size <= MAX_FULL_BYTES ? titleIn(readTail(path, MAX_FULL_BYTES)) : null;
  } catch {
    return null;
  }
}

/** This conversation's title, or null when it cannot be told. Never throws. */
export function sessionTitle(probe: CallProbe, opts: { roots?: string[]; env?: NodeJS.ProcessEnv; now?: number } = {}): string | null {
  try {
    const env = opts.env ?? process.env;
    const roots = opts.roots ?? projectRoots(env);
    for (const path of recentSessions(roots, opts.now)) {
      let tail: string;
      try { tail = readTail(path, TAIL_BYTES); } catch { continue; }
      if (holdsCall(tail, probe)) return titleIn(tail) ?? titleOfFile(path);
    }
    const id = env.CLAUDE_CODE_SESSION_ID;
    if (id && /^[0-9a-f-]{8,64}$/i.test(id)) {
      for (const root of roots) {
        let projects: string[];
        try { projects = readdirSync(root); } catch { continue; }
        for (const p of projects) {
          const path = join(root, p, `${id}.jsonl`);
          if (existsSync(path)) return titleOfFile(path);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
