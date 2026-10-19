import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readBundleIndex, readState } from '@distill/capture';
import { uuid } from '@distill/shared';
import {
  findStage, lineKey, listLineRules, readByeSettings, readStaged, reviewView, setLineRules, stageSessions, startOfLocalDay, uploadStaged,
} from './core/bye.ts';
import { writeChatRecord } from './core/capture.ts';

/**
 * acta-bye's CLI half (2026-10-19): stage today's sessions without uploading,
 * read them, upload only the chosen ones, remember the declined ones, and
 * keep per-line auto/review rules. Real pipeline, real Claude Code session
 * files in a throwaway HOME, a stub upload API.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '../../../packages/adapters/__fixtures__/claude_code_session/happy/input.jsonl');

let home: string;
let stateHome: string;
let api: Server;
let apiBase = '';
const inits: { runs: number; bundle_id: string }[] = [];
const puts: string[] = [];

/** A Claude Code session file for repo `cwd`, last written at `mtime`. */
function session(cwd: string, sessionId: string, ask: string, mtime: Date): string {
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => {
    const o = JSON.parse(l) as Record<string, unknown> & { message: { content: unknown } };
    o.sessionId = sessionId;
    if (o.cwd) o.cwd = cwd;
    if (o.type === 'user' && typeof o.message.content === 'string') o.message.content = ask;
    return JSON.stringify(o);
  });
  const dir = join(home, '.claude', 'projects', cwd.replace(/[\\/:]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, `${lines.join('\n')}\n`);
  utimesSync(p, mtime, mtime);
  return p;
}

const linkedConfig = () => writeFileSync(join(stateHome, 'config.json'), JSON.stringify({
  version: 1, api_url: apiBase, token: 'distill_pat_stub', source_id: uuid(), redaction_profile: 'general', upload_diffs: true,
  disabled_redaction_rules: [], extra_paths: [], sources: [],
}));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'actario-bye-'));
  stateHome = join(home, '.actario');
  mkdirSync(stateHome, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ACTARIO_HOME = stateHome;

  api = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/uploads/init') {
        const b = JSON.parse(raw) as { bundle_meta: { bundle_id: string }; capture_report: { runs_kept: number }; files: { name: string }[] };
        inits.push({ runs: b.capture_report.runs_kept, bundle_id: b.bundle_meta.bundle_id });
        return send(200, { upload_id: uuid(), resumed: false, urls: b.files.map((f) => ({ name: f.name, signed_url: `${apiBase}/put/${encodeURIComponent(f.name)}` })) });
      }
      if (req.url?.startsWith('/put/')) { puts.push(decodeURIComponent(req.url.slice(5))); return send(200, {}); }
      if (req.url?.endsWith('/complete')) return send(200, { status: 'complete' });
      send(404, { error: { code: 'not_found', message: 'stub' } });
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  linkedConfig();

  const now = new Date();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  session('/work/shop-site', 'aaaaaaaa-0000-4000-8000-000000000001', '結帳頁的運費要改成依地區計算', now);
  session('/work/shop-site', 'aaaaaaaa-0000-4000-8000-000000000002', '把商品頁的圖片改成延遲載入', now);
  session('/work/thesis', 'aaaaaaaa-0000-4000-8000-000000000003', '第三章的實驗表格重排', now);
  session('/work/thesis', 'aaaaaaaa-0000-4000-8000-000000000004', '前天的舊對話，不該出現', twoDaysAgo);
});

afterAll(async () => { await new Promise<void>((r) => api.close(() => r())); });
beforeEach(() => { inits.length = 0; puts.length = 0; });

describe('staging: today\'s sessions, nothing uploaded', () => {
  it('finds the sessions written since local midnight, redacted and staged, with a review line each', async () => {
    const r = await stageSessions();
    expect(r.kind).toBe('staged');
    if (r.kind !== 'staged') return;
    expect(r.meta.runs).toHaveLength(3);                       // not the one from two days ago
    expect(inits).toHaveLength(0);                             // nothing left the machine
    const asks = r.meta.runs.map((x) => x.first_ask).sort();
    expect(asks).toContain('結帳頁的運費要改成依地區計算');
    for (const x of r.meta.runs) {
      expect(x.line?.ref).toMatch(/^\/work\//);
      expect(x.run_hash).toHaveLength(64);
      expect(x.files_changed.length).toBeGreaterThan(0);
    }
    expect(r.meta.since).toBe(startOfLocalDay().toISOString());
    // The high-water mark has not moved: a stage is not an upload.
    expect(Object.keys(readState().sources)).toHaveLength(0);
  });

  it('every line starts as review: no rule means ask', async () => {
    const view = reviewView(findStage());
    expect(view.every((v) => v.policy === 'review' && v.new_line)).toBe(true);
  });

  it('brief reading gives every turn short and no tool calls; full is read_run\'s shape', async () => {
    const st = findStage();
    const h = st.runs[0]!.run_hash;
    const brief = await readStaged(undefined, h.slice(0, 12)) as { turns: { content: string }[]; files_changed: string[] };
    expect(brief.turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(brief)).not.toContain('tool_calls');
    const full = await readStaged(st.stage_id.slice(0, 8), h, 'full') as { run_hash: string; turns: unknown[] };
    expect(full.run_hash).toBe(h);
  });

  it('the conversation the scan runs from is marked current when it comes as a record', async () => {
    const recordPath = writeChatRecord({ format: 'distill.chat/v1', platform: 'cowork', title: '下班整理', project: 'Shop site', turns: [
      { role: 'user', content: '幫我把今天的對話整理一下' }, { role: 'assistant', content: '好，先列出今天的 session。' },
    ] }, 'bye');
    const r = await stageSessions({ recordPath });
    expect(r.kind).toBe('staged');
    if (r.kind !== 'staged') return;
    const cur = r.meta.runs.filter((x) => x.current);
    expect(cur).toHaveLength(1);
    expect(cur[0]!.line).toEqual({ ref: 'Shop site', name: 'Shop site conversations' });
  });
});

describe('upload: only what was chosen', () => {
  it('uploads the chosen runs as one bundle, remembers the declined, leaves the rest staged', async () => {
    const st = findStage();
    const [a, b, c] = st.runs.filter((x) => !x.current);
    const r = await uploadStaged(undefined, [a!.run_hash.slice(0, 12)], [b!.run_hash]);
    expect(r.kind).toBe('uploaded');
    if (r.kind !== 'uploaded') return;
    expect(inits).toEqual([{ runs: 1, bundle_id: r.bundleId }]);
    expect(puts.some((p) => p.startsWith('runs/'))).toBe(true);

    // The bundle in the store holds exactly the chosen run, for list_runs / read_run / submit_daf.
    expect(readBundleIndex()[0]?.bundle_id).toBe(r.bundleId);
    const part = readdirSync(join(stateHome, 'bundles', r.bundleId, 'runs'))[0]!;
    const lines = gunzipSync(readFileSync(join(stateHome, 'bundles', r.bundleId, 'runs', part))).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(a!.run_hash);

    // Ledger has the hash; the mark did not move.
    const src = Object.values(readState().sources)[0]!;
    expect(src.uploaded_hashes).toContain(a!.run_hash);
    expect(src.last_seen_at).toBeNull();

    expect(readByeSettings().skipped).toContain(b!.run_hash);
    const view = reviewView(findStage());
    expect(view.find((v) => v.run_hash === a!.run_hash)?.uploaded).toBe(true);
    expect(view.find((v) => v.run_hash === b!.run_hash)?.skipped_before).toBe(true);
    expect(view.find((v) => v.run_hash === c!.run_hash)?.uploaded).toBe(false);
  });

  it('the next scan does not offer the uploaded one again, and marks the declined one', async () => {
    const r = await stageSessions();
    expect(r.kind).toBe('staged');
    if (r.kind !== 'staged') return;
    const view = reviewView(r.meta);
    expect(view).toHaveLength(3);                              // 4 today (3 sessions + record) minus the uploaded one
    expect(view.filter((v) => v.skipped_before)).toHaveLength(1);
    expect(r.outcome.skippedDuplicates).toBe(1);
  });

  it('skip only, nothing to upload: no network at all', async () => {
    const st = findStage();
    const r = await uploadStaged(undefined, [], [st.runs[0]!.run_hash]);
    expect(r.kind).toBe('uploaded');
    expect(inits).toHaveLength(0);
  });

  it('an unlinked machine says so and keeps the batch', async () => {
    writeFileSync(join(stateHome, 'config.json'), JSON.stringify({ version: 1 }));
    const st = findStage();
    const r = await uploadStaged(undefined, [st.runs[0]!.run_hash]);
    expect(r.kind).toBe('not_linked');
    expect(existsSync(join(stateHome, 'staged', st.stage_id, 'stage.json'))).toBe(true);
    linkedConfig();
  });
});

describe('upload rules: per line, no global switch', () => {
  it('set by ref or by name; the line\'s runs then come back as auto, other lines stay review', async () => {
    setLineRules([{ line: '/work/shop-site', mode: 'auto' }]);
    setLineRules([{ line: 'thesis coding session', mode: 'review' }]);
    const rules = listLineRules();
    expect(rules.map((r) => [r.name, r.mode])).toEqual([['shop-site coding session', 'auto'], ['thesis coding session', 'review']]);
    const view = reviewView(findStage());
    for (const v of view) {
      if (v.line?.ref === '/work/shop-site') expect(v.policy).toBe('auto');
      else expect(v.policy).toBe('review');
    }
    // The record's line ("Shop site", a project, not the repo) has no rule: reviewed, and flagged new.
    expect(view.find((v) => v.line?.ref === 'Shop site')).toMatchObject({ policy: 'review', new_line: true });
  });

  it('a name that matches nothing, or more than one line, is refused with the lines it knows', () => {
    expect(() => setLineRules([{ line: 'no such line', mode: 'auto' }])).toThrow(/Known lines/);
    expect(() => setLineRules([{ line: 'coding session', mode: 'auto' }])).toThrow(/more than one line/);
  });

  it('line keys: Windows paths fold case and slashes; project names never do', () => {
    expect(lineKey('D:/Work/Repo/', 'win32')).toBe('d:\\work\\repo');
    expect(lineKey('D:\\Work\\Repo', 'win32')).toBe('d:\\work\\repo');
    expect(lineKey('/Users/Me/Repo', 'darwin')).toBe('/Users/Me/Repo');
    expect(lineKey('Distill', 'win32')).toBe('Distill');
  });
});
