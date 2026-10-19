import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keepBundle, packBundle, CQS_VERSION } from '@distill/capture';
import { writeEncrypted } from '@distill/redaction';
import {
  checkMemoryPack, uuid, type BundleMeta, type CaptureReport, type MemoryPackSave, type TranscriptPage,
  type TranscriptRun, type TranscriptSegment, type TranscriptTurn,
} from '@distill/shared';
import type { UcfRun } from '@distill/ucf';
import type { ApiOptions } from './api.ts';
import {
  NOT_RESTORED, NotLinkedError, buildRunMemory, fetchMemorySources, fetchRunToCache, findRestored, loadMemory,
  pageLines, readRestoredAnswer, restoreAnswer, runDirKey, saveMemory, takeTurns,
} from './core/restore.ts';
import { estimateTokens } from '@distill/shared';

/**
 * Restore and memory on the machine side (arch v2.1 ch. 22), against a fake
 * API that speaks the real contracts (packages/shared/src/contracts/restore.ts)
 * and runs the same pack checker the real route does. What these pin down:
 * where things are written, what a tool answer may hold, what is never
 * written (unmasked values), and the checks a pack must pass before it is
 * saved anywhere.
 */

const H1 = `a1${'b2c3d4e5'.repeat(7)}f6a7b8`;
const H2 = `9f${'8e7d6c5b'.repeat(7)}4a3928`;
const RUN1 = '70000000-0000-4000-8000-000000000001';
const RUN2 = '70000000-0000-4000-8000-000000000002';
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';

const tRun = (id: string, hash: string, n: number, title: string, started: string): TranscriptRun => ({
  id, run_hash: hash, title, platform: 'claude_code', model: null, started_at: started, ended_at: null,
  outcome: 'completed', turns: n, agent: { id: 'b1000000-0000-4000-8000-000000000001', name: 'B1' }, workspace_id: WS,
});
const turnsOf = (n: number, text: (i: number) => string): TranscriptTurn[] => Array.from({ length: n }, (_, idx) => ({
  idx, role: idx % 2 ? 'assistant' : 'user', content: text(idx), timestamp: null, tool_calls: idx === 3 ? [{ name: 'Bash', ok: false }] : null,
  tool_result: idx === 3 ? 'x'.repeat(5000) : null, result_truncated: idx === 3, content_cleared: false,
}));

const PAGE: TranscriptPage = {
  title: 'LOPO 評估', summary: '把切分改成 LOPO；基線還沒重跑。', labels: ['eval'], version: 2, origin: 'human', updated_at: '2026-10-05T00:00:00.000Z',
  sections: [
    { heading: '目標', start_turn_idx: 0, end_turn_idx: 2, body: '在 LOPO 上重跑 v3 基線。' },
    { heading: '還沒完成', start_turn_idx: 8, end_turn_idx: 11, body: '- 基線重跑' },
  ],
};
const SEGS: TranscriptSegment[] = [{ start_turn_idx: 0, end_turn_idx: 5, topic: '切分', summary: '決定改用 LOPO', labels: [] }];

const fake = {
  runs: new Map<string, { run: TranscriptRun; turns: TranscriptTurn[]; segments: TranscriptSegment[]; page: TranscriptPage | null }>(),
  packs: new Map<string, { version: number; saves: MemoryPackSave[] }>(),
  calls: [] as string[],
};

function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://x');
  fake.calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const lookup = (ref: string) => [...fake.runs.values()].find((r) => r.run.id === ref || r.run.run_hash.startsWith(ref));

  if (url.pathname === '/api/v1/me') return send(200, { kind: 'user', scopes: ['read', 'capture'], workspace_id: WS, user_id: uuid(), agent_id: null, via: 'pat', can_capture: true });
  const t = /^\/api\/v1\/runs\/([^/]+)\/transcript$/.exec(url.pathname);
  if (t) {
    const r = lookup(decodeURIComponent(t[1]!));
    if (!r) return send(404, { error: { code: 'not_found', message: 'No such run' } });
    const from = Number(url.searchParams.get('from') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    const page = r.turns.filter((x) => x.idx >= from).slice(0, limit + 1);
    const inc = (url.searchParams.get('include') ?? '').split(',');
    return send(200, {
      run: r.run, turns: page.slice(0, limit), next_from: page.length > limit ? page[limit]!.idx : null,
      ...(inc.includes('segments') ? { segments: r.segments } : {}),
      ...(inc.includes('page') ? { page: r.page } : {}),
      ...(inc.includes('artifacts') ? { artifacts: [{ path: 'eval.py', change: 'modified', diff_summary: '+3 -1' }] } : {}),
    });
  }
  if (url.pathname === '/api/v1/memory-sources') {
    const runs = [...fake.runs.values()].sort((a, b) => a.run.started_at.localeCompare(b.run.started_at));
    return send(200, {
      scope: { runs: null, agent: url.searchParams.get('agent'), since: null, until: null },
      sources: runs.map((r) => ({ run: r.run, segments: r.segments, page: r.page })), truncated: false,
    });
  }
  if (url.pathname === '/api/v1/memory-packs' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as MemoryPackSave;
      const check = checkMemoryPack(body.body, { anchors: body.anchors });
      if (check.errors.length) return send(422, { error: { code: 'invalid_request', message: 'bad pack', details: check.errors } });
      const p = fake.packs.get(body.pack_id) ?? { version: 0, saves: [] };
      if (body.base_version !== p.version) return send(409, { error: { code: 'memory_conflict', message: 'changed' } });
      p.version += 1; p.saves.push(body); fake.packs.set(body.pack_id, p);
      return send(p.version === 1 ? 201 : 200, { pack_id: body.pack_id, version: p.version, created: p.version === 1 });
    });
    return;
  }
  const mp = /^\/api\/v1\/memory-packs\/([^/]+)$/.exec(url.pathname);
  if (mp) {
    const p = fake.packs.get(mp[1]!);
    if (!p) return send(404, { error: { code: 'not_found', message: 'No such memory pack' } });
    const last = p.saves[p.saves.length - 1]!;
    return send(200, {
      pack: { id: mp[1], workspace_id: WS, title: last.title, scope: last.scope, current_version: p.version, created_at: last.as_of, updated_at: last.as_of },
      shown: { version: p.version, as_of: last.as_of, budget: last.budget, body: last.body, anchors: last.anchors, run_ids: [], client_prompt_version: null, created_at: last.as_of },
      versions: [],
    });
  }
  return send(404, { error: { code: 'not_found', message: url.pathname } });
}

let server: Server;
let api: ApiOptions;
let home: string;

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  api = { baseUrl: `http://127.0.0.1:${addr.port}`, token: 'distill_pat_test' };
});
afterAll(() => { server?.close(); });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'actario-restore-'));
  process.env.ACTARIO_HOME = home;
  fake.runs.clear(); fake.packs.clear(); fake.calls.length = 0;
  fake.runs.set(RUN1, {
    run: tRun(RUN1, H1, 12, 'LOPO 評估', '2026-10-01T02:00:00.000Z'),
    turns: turnsOf(12, (i) => `turn ${i}: 寄給 EMAIL-3F2A91 的那封信，還有 EMAIL-ABCDEF`), segments: SEGS, page: PAGE,
  });
  fake.runs.set(RUN2, {
    run: tRun(RUN2, H2, 600, '長對話', '2026-10-03T02:00:00.000Z'),
    turns: turnsOf(600, (i) => `long turn ${i} ${'內容'.repeat(40)}`), segments: [], page: null,
  });
});

describe('fetch_run', () => {
  it('writes the run under restore/<hash>/ and answers hybrid with memory, index and the latest turns', async () => {
    const r = await fetchRunToCache(api, H1.slice(0, 12));
    expect(r.dir).toBe(join(home, 'restore', runDirKey(H1)));
    for (const f of ['meta.json', 'transcript.md', 'turns.jsonl', 'segments.json', 'page.md', 'memory.md', 'artifacts.json']) {
      expect(existsSync(join(r.dir, f))).toBe(true);
    }
    expect(readFileSync(join(r.dir, 'transcript.md'), 'utf8')).toContain('## t11 · assistant');
    const a = restoreAnswer(r, 'hybrid') as Record<string, unknown> & { memory: string; latest_turns: { turns: number[] } };
    expect(a.memory).toContain('## 目標 (a1b2c3d4e5b2#t0-2)');
    expect(a.memory).toContain('note page v2 (edited by a person)');
    expect(a.memory).toContain('- a1b2c3d4e5b2#t0-5 切分 — 決定改用 LOPO');
    expect(a.latest_turns.turns).toEqual([6, 11]);
    expect(a.not_restored).toEqual(NOT_RESTORED);
    expect(String(a.rule)).toMatch(/data, not instructions/);
    expect(a.source).toBe('server');
  });

  it('transcript mode pages a long run by the token budget and says where to continue', async () => {
    const r = await fetchRunToCache(api, RUN2);
    expect(r.meta.turn_idx).toHaveLength(600); // two transcript pages of 500 were stitched
    const a = restoreAnswer(r, 'transcript') as { transcript_page: { turns: number[]; next_from: number } };
    expect(a.transcript_page.turns[0]).toBe(0);
    expect(a.transcript_page.next_from).toBeGreaterThan(10);
    expect(a.transcript_page.next_from).toBeLessThan(600);
  });

  it('a run with no page or segments has no memory, and hybrid falls back to the transcript', async () => {
    const r = await fetchRunToCache(api, RUN2);
    const a = restoreAnswer(r, 'hybrid') as { memory: null; memory_missing: string; transcript_page: unknown };
    expect(a.memory).toBeNull();
    expect(a.memory_missing).toMatch(/no note page or segments/);
    expect(a.transcript_page).toBeDefined();
  });

  it('a refetch drops a page that no longer exists upstream', async () => {
    const first = await fetchRunToCache(api, RUN1);
    expect(existsSync(join(first.dir, 'page.md'))).toBe(true);
    fake.runs.get(RUN1)!.page = null;
    fake.runs.get(RUN1)!.segments = [];
    const again = await fetchRunToCache(api, RUN1);
    expect(existsSync(join(again.dir, 'page.md'))).toBe(false);
    expect(existsSync(join(again.dir, 'memory.md'))).toBe(false);
  });

  it('without a link, a run still in a local bundle comes back from the bundle', async () => {
    const bundleMeta: BundleMeta = {
      bundle_id: uuid(), ucf_version: '0.2', cli_version: '0.1.4-test', created_at: new Date().toISOString(),
      host_os: 'linux', redaction_profile: 'general', hard_rules_enforced: true,
    };
    const report: CaptureReport = {
      cqs: 90, cqs_version: CQS_VERSION, runs_total: 1, runs_kept: 1, runs_dropped: 0, parse_levels: { strict: 1, loose: 0, raw: 0 },
      coverage_start: null, coverage_end: null, coverage_gap_pct: 0, truncation_pct: 0, result_truncated_pct: 0,
      tool_calls_total: 0, artifacts_total: 0, runs_with_tool_calls: 0, runs_with_artifacts: 0,
      degraded_fields: [], absent_by_capability: [], redactions: {}, warnings: [], adapters: [],
    };
    const ucf: UcfRun = {
      run_ref: 'run:local', agent_ref: null, platform: 'claude_code', model: null, started_at: '2026-10-06T00:00:00+08:00', ended_at: null,
      outcome: 'ongoing', title: 'only here', binding_hints: [],
      turns: [0, 1, 2].map((idx) => ({ idx, role: idx % 2 ? 'assistant' : 'user', content: `local ${idx}`, timestamp: null, tool_calls: null, branch_id: null, parent_turn_ref: null, truncated: false, tool_result: null, result_truncated: false, raw_ext: {} })),
      artifacts: [], parse_level: 'strict', adapter_id: 'claude_code_session', adapter_version: '1', degraded_fields: [], absent_by_capability: [],
      raw_ext: { content_hash: 'c0ffee00c0ffee00c0ffee00' },
    };
    const pack = await packBundle({ outDir: mkdtempSync(join(tmpdir(), 'actario-pack-')), bundleMeta, captureReport: report, agents: [], runs: [ucf], droppedRuns: [] });
    keepBundle(pack.bundleDir, { bundle_id: bundleMeta.bundle_id, upload_id: null, runs: 1 });

    const r = await fetchRunToCache(null, 'c0ffee00c0ffee');
    expect(r.meta.source).toEqual({ kind: 'local_bundle', bundle_id: bundleMeta.bundle_id });
    expect(r.turns.map((t) => t.content)).toEqual(['local 0', 'local 1', 'local 2']);
    await expect(fetchRunToCache(null, 'deadbeefdeadbeef')).rejects.toBeInstanceOf(NotLinkedError);
  });
});

describe('read_restored', () => {
  it('reads a range, caps tool output, and is found again by id or prefix', async () => {
    await fetchRunToCache(api, RUN1);
    const r = findRestored(RUN1);
    expect(r && r !== 'ambiguous' && r.meta.run.run_hash).toBe(H1);
    const a = readRestoredAnswer(findRestored(H1.slice(0, 12)) as never, { from: 2, to: 4 }) as { turns: number[]; next_from: number | null; text: string };
    expect(a.turns).toEqual([2, 4]);
    expect(a.next_from).toBeNull();
    expect(a.text).toContain('_tools: Bash (failed)_');
    expect(a.text).toContain('… [5000 chars]');
  });

  it('unmask reverses only what this machine\'s map knows, in the answer only -- never on disk', async () => {
    const r = await fetchRunToCache(api, RUN1);
    const reverse = new Map([['EMAIL-3F2A91', 'kestrel@example.com']]);
    const a = readRestoredAnswer(r, { from: 0, to: 0, unmask: true, reverse }) as { text: string; unmask: { applied: boolean; report: { unknown: number } } };
    expect(a.text).toContain('寄給 kestrel@example.com');
    expect(a.text).toContain('EMAIL-ABCDEF');
    expect(a.unmask.report.unknown).toBe(1);
    expect(readFileSync(join(r.dir, 'turns.jsonl'), 'utf8')).not.toContain('kestrel@example.com');
    expect(readFileSync(join(r.dir, 'transcript.md'), 'utf8')).not.toContain('kestrel@example.com');

    const none = readRestoredAnswer(r, { from: 0, to: 0, unmask: true, reverse: null }) as { unmask: { applied: boolean; note: string } };
    expect(none.unmask.applied).toBe(false);
    expect(none.unmask.note).toMatch(/machine that captured/);
  });

  it('the local map on disk is what localReverseMap reads', async () => {
    const { localReverseMap } = await import('./core/restore.ts');
    expect(localReverseMap()).toBeNull();
    writeFileSync(join(home, 'salt'), 'abcdef0123456789abcdef0123456789\n');
    writeEncrypted(join(home, 'redaction_map.json.enc'), 'abcdef0123456789abcdef0123456789', { version: 1, entries: [{ original: 'kestrel@example.com', pseudonym: 'EMAIL-3F2A91' }] });
    expect(localReverseMap()?.get('EMAIL-3F2A91')).toBe('kestrel@example.com');
  });

  it('part: memory / page; a range outside the run is a not_found', async () => {
    const r = await fetchRunToCache(api, RUN1);
    expect((readRestoredAnswer(r, { from: 0, to: 0, part: 'page' }) as { text: string }).text).toContain('# LOPO 評估');
    expect(() => readRestoredAnswer(r, { from: 50, to: 60 })).toThrow(/No turns between 50 and 60/);
  });
});

describe('memory', () => {
  const body = (p1: string, p2: string) => [
    '> 截至 2026-10-07，涵蓋 2 個 run。',
    '',
    '## 目標',
    `- 在 LOPO 切分上重跑 v3 基線 (${p1}#t0-2)`,
    '',
    '## 待完成',
    `- 基線重跑 (${p1}#t8-11)`,
    `- 長對話裡提到的整理 (${p2}#t100-120)`,
    '',
    '## 假名對照',
    `- EMAIL-3F2A91：寄信對象 (${p1}#t0)`,
  ].join('\n');

  it('fetches the sources into the restore cache and hands back a digest with anchors', async () => {
    const out = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    expect(out.runs.map((r) => r.run_hash)).toEqual([H1, H2]);
    expect(out.digest).toContain('- 目標 (a1b2c3d4e5b2#t0-2)');
    expect(out.digest).toContain('(no note page or segments: read the turns)');
    expect(existsSync(join(out.folder, 'sources.json'))).toBe(true);
    expect(findRestored(H2)).not.toBeNull();
    expect(fake.calls.some((c) => c.startsWith('GET /api/v1/memory-sources?agent=B1'))).toBe(true);
  });

  it('save_memory writes the front matter itself, checks, and saves locally only by default', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    const r = await saveMemory({ pack_id: src.pack_id, title: 'LOPO 工作線', body: body('a1b2c3d4e5b2', '9f8e7d6c5b8e'), budget: 'M', upload: false, api });
    expect(r.kind).toBe('saved');
    if (r.kind !== 'saved') return;
    expect(r.uploaded).toBeNull();
    expect(r.doc.startsWith(`---\nformat: actario.memory/v1\npack_id: ${src.pack_id}\n`)).toBe(true);
    expect(r.check.anchors.map((a) => [a.run_hash, a.from, a.to])).toEqual([[H1, 0, 2], [H1, 8, 11], [H2, 100, 120], [H1, 0, 0]]);
    expect(fake.calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(JSON.parse(readFileSync(join(src.folder, 'pack.json'), 'utf8'))).toMatchObject({ budget: 'M', local_versions: 1, server: null });
  });

  it('nothing is saved when a check fails: an unanchored line, a turn the run does not have, a missing to-do', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    const bad = body('a1b2c3d4e5b2', '9f8e7d6c5b8e').replace('(a1b2c3d4e5b2#t8-11)', '').replace('#t100-120', '#t100-999');
    const r = await saveMemory({ pack_id: src.pack_id, title: 't', body: bad, budget: 'M', upload: false, api });
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.check.errors.map((e) => e.code).sort()).toEqual(['range_not_in_run', 'unanchored_line']);
    expect(existsSync(join(src.folder, 'memory.md'))).toBe(false);
  });

  it('the redaction rules run over the text before anything is checked or written', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    const leaky = body('a1b2c3d4e5b2', '9f8e7d6c5b8e').replace('寄信對象', '寄信對象 someone.real@corp-mail.com');
    const r = await saveMemory({ pack_id: src.pack_id, title: 't', body: leaky, budget: 'M', upload: false, api });
    expect(r.kind).toBe('saved');
    expect(r.redacted).toBeGreaterThan(0);
    expect(readFileSync(join(src.folder, 'memory.md'), 'utf8')).not.toContain('someone.real@corp-mail.com');
  });

  it('upload: the server gets the same anchors the text has; the next save builds on that version; a stale base is a conflict', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    const b = body('a1b2c3d4e5b2', '9f8e7d6c5b8e');
    const r1 = await saveMemory({ pack_id: src.pack_id, title: 'LOPO', body: b, budget: 'M', upload: true, api });
    expect(r1.kind === 'saved' && r1.uploaded).toEqual({ pack_id: src.pack_id, version: 1, created: true });
    const r2 = await saveMemory({ pack_id: src.pack_id, title: 'LOPO', body: `${b}\n- 補充 (a1b2c3d4e5b2#t9)`, budget: 'M', upload: true, api });
    expect(r2.kind === 'saved' && r2.uploaded?.version).toBe(2);
    expect(fake.packs.get(src.pack_id)!.saves[1]!.base_version).toBe(1);
    await expect(saveMemory({ pack_id: src.pack_id, title: 'LOPO', body: b, budget: 'M', upload: true, base_version: 1, api }))
      .rejects.toMatchObject({ code: 'memory_conflict' });
    // the local save stood even though the upload was refused
    expect(readFileSync(join(src.folder, 'memory.md'), 'utf8')).not.toContain('補充');
  });

  it('upload without a link saves locally and says so', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    await expect(saveMemory({ pack_id: src.pack_id, title: 't', body: body('a1b2c3d4e5b2', '9f8e7d6c5b8e'), budget: 'M', upload: true, api: null }))
      .rejects.toBeInstanceOf(NotLinkedError);
    expect(existsSync(join(src.folder, 'memory.md'))).toBe(true);
  });

  it('load_memory: from the server onto a machine that never had it, then the local copy', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    await saveMemory({ pack_id: src.pack_id, title: 'LOPO', body: body('a1b2c3d4e5b2', '9f8e7d6c5b8e'), budget: 'S', upload: true, api });

    process.env.ACTARIO_HOME = mkdtempSync(join(tmpdir(), 'actario-other-machine-'));
    const m = await loadMemory(api, src.pack_id);
    expect(m.source).toBe('server');
    expect(m.doc).toContain('## 待完成');
    const again = await loadMemory(api, src.pack_id);
    expect(again.source).toBe('local');
    // and it can be the base of the next version from here
    const sources = JSON.parse(readFileSync(join(process.env.ACTARIO_HOME!, 'memory', src.pack_id, 'sources.json'), 'utf8'));
    expect(sources.runs.map((r: { run_hash: string }) => r.run_hash)).toEqual([H1, H2]);
  });
});

describe('answers stay inside one tool result', () => {
  it('a single turn bigger than the budget is cut, and says where the whole text is', () => {
    const giant = turnsOf(1, () => 'log line\n'.repeat(40000));
    const t = takeTurns(giant, 0, 0, 12000, 2000, '/x/transcript.md');
    expect(estimateTokens(t.text)).toBeLessThanOrEqual(12000);
    expect(t.text).toContain('turn t0 cut here');
    expect(t.text).toContain('/x/transcript.md');
    const oneLine = takeTurns(turnsOf(1, () => 'x'.repeat(400000)), 0, 0, 12000);
    expect(estimateTokens(oneLine.text)).toBeLessThanOrEqual(12000);
  });

  it('pageLines pages a long memory by line and says where to continue', () => {
    const text = Array.from({ length: 3000 }, (_, i) => `- 第 ${i} 項 (a1b2c3d4e5f6#t${i})`).join('\n');
    const a = pageLines(text, 1, 14000);
    expect(estimateTokens(a.text)).toBeLessThanOrEqual(14000);
    expect(a.next_line).toBeGreaterThan(1);
    const b = pageLines(text, a.next_line!, 14000);
    expect(b.text.split('\n')[0]).toBe(`- 第 ${a.next_line! - 1} 項 (a1b2c3d4e5f6#t${a.next_line! - 1})`);
  });

  it('the index is capped', async () => {
    fake.runs.get(RUN1)!.segments = Array.from({ length: 200 }, (_, i) => ({ start_turn_idx: 0, end_turn_idx: 1, topic: `seg ${i}`, summary: null, labels: [] }));
    const r = await fetchRunToCache(api, RUN1);
    const a = restoreAnswer(r, 'memory') as { index: { segments: unknown[]; segments_more: number } };
    expect(a.index.segments).toHaveLength(80);
    expect(a.index.segments_more).toBe(120);
  });

  it('a run hash that is not hex is shown whole in anchors, not by a prefix every run of the adapter shares', async () => {
    fake.runs.set('70000000-0000-4000-8000-000000000009', {
      run: tRun('70000000-0000-4000-8000-000000000009', 'cowork_live:chat-2026-10-07', 4, 'x', '2026-10-07T00:00:00.000Z'),
      turns: turnsOf(4, (i) => `t${i}`), segments: SEGS, page: null,
    });
    const r = await fetchRunToCache(api, '70000000-0000-4000-8000-000000000009');
    expect(r.memory).toContain('cowork_live:chat-2026-10-07#t0-5');
  });
});

describe('memory: real values and lost work', () => {
  const pseudo = 'EMAIL-3F2A91';
  const writeMap = () => {
    writeFileSync(join(home, 'salt'), 'abcdef0123456789abcdef0123456789\n');
    writeEncrypted(join(home, 'redaction_map.json.enc'), 'abcdef0123456789abcdef0123456789',
      { version: 1, entries: [{ original: 'Kestrel Huang', pseudonym: 'NAME-77AA01' }, { original: 'kestrel@example.com', pseudonym: pseudo }] });
  };
  const body = (extra = '') => `> 截至 2026-10-07。\n\n## 目標\n- 重跑基線 (a1b2c3d4e5b2#t0-2)${extra}\n\n## 待完成\n- 基線 (a1b2c3d4e5b2#t8-11)\n`;

  it('a real value this machine\'s map knows goes back to its pseudonym before anything is written -- the title too', async () => {
    writeMap();
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    const r = await saveMemory({ pack_id: src.pack_id, title: 'Kestrel Huang 的工作線', body: body('，跟 Kestrel Huang 確認過'), budget: 'M', upload: true, api });
    expect(r.kind).toBe('saved');
    const onDisk = readFileSync(join(src.folder, 'memory.md'), 'utf8');
    expect(onDisk).not.toContain('Kestrel Huang');
    expect(onDisk).toContain('NAME-77AA01');
    expect(r.redacted).toBe(2);
    expect(fake.packs.get(src.pack_id)!.saves[0]!.body).not.toContain('Kestrel Huang');
    expect(fake.packs.get(src.pack_id)!.saves[0]!.title).toBe('NAME-77AA01 的工作線');
  });

  it('after a conflict, loading the server copy keeps the local one beside it', async () => {
    const src = await fetchMemorySources(api, { scope: { agent: 'B1' } });
    await saveMemory({ pack_id: src.pack_id, title: 't', body: body(), budget: 'M', upload: true, api });
    // someone else saves version 2 from another machine
    const v1 = fake.packs.get(src.pack_id)!;
    v1.saves.push({ ...v1.saves[0]!, body: v1.saves[0]!.body.replace('重跑基線', '重跑基線（另一台）') });
    v1.version = 2;
    await expect(saveMemory({ pack_id: src.pack_id, title: 't', body: body('，本機的補充'), budget: 'M', upload: true, api }))
      .rejects.toMatchObject({ code: 'memory_conflict' });
    const m = await loadMemory(api, src.pack_id);
    expect(m.source).toBe('server');
    expect(m.doc).toContain('另一台');
    expect(readFileSync(m.kept_local!, 'utf8')).toContain('本機的補充');
  });
});

describe('buildRunMemory', () => {
  it('is null when there is nothing to build from', () => {
    expect(buildRunMemory(tRun(RUN1, H1, 3, 't', '2026-10-01T00:00:00.000Z'), [], null)).toBeNull();
  });
  it('anchors a section without a range as no anchor', () => {
    const m = buildRunMemory(tRun(RUN1, H1, 3, 't', '2026-10-01T00:00:00.000Z'), [], { ...PAGE, sections: [{ heading: '備註', start_turn_idx: null, end_turn_idx: null, body: 'x' }] })!;
    expect(m).toContain('## 備註\n');
  });
});

// keep the fixture helpers honest about the folder they write to
it('ACTARIO_HOME isolates every case', () => {
  mkdirSync(join(home, 'restore'), { recursive: true });
  expect(findRestored(H1)).toBeNull();
});
