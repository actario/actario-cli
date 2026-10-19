import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bundleLineHash, composeRunExport, runCaptures, runExportFileName, type RunExportMeta, type RunExportSource } from './compose-run.ts';
import { EXPORT_FORMAT } from './compose.ts';
import { readZip, zipToBuffer } from './zip.ts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const line = (hash: string, title: string) => JSON.stringify({ run_ref: title, adapter_id: 'claude-code', title, raw_ext: { content_hash: hash }, turns: [] });
const gz = (...lines: string[]) => gzipSync(Buffer.from(`${lines.join('\n')}\n`));

const run = {
  id: '70000000-0000-4000-8000-000000000001', workspace_id: 'ws-a', agent_id: 'ag1', upload_id: 'up1',
  title: 'Export 搬到 Sessions', platform: 'claude-code', version: 2, content_hash: H1, created_at: '2026-10-15T01:00:00.000Z',
};
const versions = [
  { run_id: run.id, version: 2, upload_id: 'up2', content_hash: H2, mode: 'append' },
  { run_id: run.id, version: 1, upload_id: 'up1', content_hash: H1, mode: 'initial' },
];

function source(over: Partial<RunExportSource> = {}): RunExportSource {
  const parts: Record<string, Record<string, Uint8Array | null>> = {
    // up1 carried this session and another one, over two parts.
    up1: { 'runs/000001.ndjson.gz': gz(line(OTHER, 'someone else'), line(H1, 'v1')), 'runs/000002.ndjson.gz': gz(line(OTHER, 'x')) },
    up2: { 'runs/000001.ndjson.gz': gz(line(H2, 'v2')) },
  };
  return {
    run,
    versions,
    bundleParts: async (u) => (parts[u] ? Object.keys(parts[u]) : null),
    bundleFile: async (u, n) => {
      const b = parts[u]?.[n] ?? null;
      // stream one of them, to cover both shapes
      return b && u === 'up2' ? (async function* () { yield b.subarray(0, 5); yield b.subarray(5); })() : b;
    },
    turns: async (id) => [{ id: 't0', run_id: id, idx: 0 }, { id: 't1', run_id: id, idx: 1 }],
    artifacts: async () => [],
    entries: async (id) => [{ id: 'e1', run_id: id, agent_id: 'ag2' }],
    agents: async (ids) => ids.map((id) => ({ id })),
    ...over,
  };
}

async function build(src: RunExportSource) {
  const buf = await zipToBuffer(composeRunExport(src, { exportedBy: 'user-a', now: () => new Date('2026-10-24T02:00:00.000Z') }));
  const byName = new Map(readZip(buf).map((m) => [m.name, m]));
  const meta = JSON.parse(byName.get('export.json')!.data().toString()) as RunExportMeta;
  return { byName, meta };
}

describe('composeRunExport', () => {
  it('keeps only this session: its DB rows, and its own lines from every upload it came from', async () => {
    const { byName, meta } = await build(source());
    expect([...byName.keys()]).toEqual([
      'db/runs.jsonl', 'db/run_versions.jsonl', 'db/turns.jsonl', 'db/artifacts.jsonl', 'db/entries.jsonl', 'db/agents.json',
      'bundle/v0001.ndjson.gz', 'bundle/v0002.ndjson.gz', 'export.json',
    ]);
    const v1 = gunzipSync(byName.get('bundle/v0001.ndjson.gz')!.data()).toString().trim().split('\n');
    expect(v1.map((l) => JSON.parse(l).title)).toEqual(['v1']);
    const v2 = gunzipSync(byName.get('bundle/v0002.ndjson.gz')!.data()).toString().trim().split('\n');
    expect(v2.map((l) => JSON.parse(l).title)).toEqual(['v2']);
    expect(meta.format).toBe(EXPORT_FORMAT);
    expect(meta.kind).toBe('run');
    expect(meta.pseudonymized).toBe(true);
    expect(meta.captures.map((c) => [c.version, c.upload_id, c.member, c.lines])).toEqual([
      [1, 'up1', 'bundle/v0001.ndjson.gz', 1], [2, 'up2', 'bundle/v0002.ndjson.gz', 1],
    ]);
    expect(meta.counts).toEqual({ captures: 2, bundle_lines: 2, turns: 2, artifacts: 0, entries: 1, agents: 2 });
    expect(meta.missing).toEqual([]);
  });

  it('records what is gone instead of failing', async () => {
    const { byName, meta } = await build(source({
      bundleParts: async (u) => (u === 'up1' ? ['runs/000001.ndjson.gz', '../escape'] : null),
      bundleFile: async () => null,
    }));
    expect(byName.has('bundle/v0001.ndjson.gz')).toBe(false);
    expect(meta.missing).toEqual([
      { upload_id: 'up1', name: 'runs/000001.ndjson.gz', reason: 'not_found' },
      { upload_id: 'up1', name: '../escape', reason: 'unsafe_name' },
      { upload_id: 'up1', name: null, reason: 'line_not_found' },
      { upload_id: 'up2', name: null, reason: 'upload_not_visible' },
    ]);
    expect(meta.captures.every((c) => c.member === null)).toBe(true);
    expect(byName.get('db/turns.jsonl')!.data().toString().trim().split('\n')).toHaveLength(2);
  });
});

describe('runCaptures / bundleLineHash / runExportFileName', () => {
  it('falls back to the run itself when it has no versions', () => {
    expect(runCaptures(run, [])).toEqual([{ version: 2, upload_id: 'up1', content_hash: H1 }]);
  });
  it('hashes a line the way ingest does', () => {
    expect(bundleLineHash({ raw_ext: { content_hash: H1 } })).toBe(H1);
    expect(bundleLineHash({ adapter_id: 'cc', run_ref: 'r9', raw_ext: {} })).toBe('cc:r9');
    expect(bundleLineHash({})).toBeNull();
  });
  it('names the file from an ASCII slug of the title', () => {
    expect(runExportFileName(run.id, run.title)).toBe('actario-session-export-sessions-70000000.zip');
    expect(runExportFileName(run.id, '全中文')).toBe('actario-session-70000000.zip');
  });
});
