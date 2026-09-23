import { describe, expect, it } from 'vitest';
import { composeUploadExport, EXPORT_FORMAT, type ExportMeta, type ExportSource, type ExportUpload } from './compose.ts';
import { readZip, zipToBuffer } from './zip.ts';

const enc = new TextEncoder();
const upload: ExportUpload = {
  id: '60000000-0000-4000-8000-000000000001',
  workspace_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  source_id: '50000000-0000-4000-8000-000000000001',
  bundle_ref: 'aaaaaaaa-0000-4000-8000-000000000001/bundle-1',
  status: 'completed',
  quality_score: 87,
  cqs_version: 'cqs-1.2',
  created_at: '2026-09-07T13:00:00.000Z',
  manifest: {
    files: [
      { name: 'agents.json', bytes: 2, sha256: 'a'.repeat(64) },
      { name: 'runs/000001.ndjson.gz', bytes: 10, sha256: 'b'.repeat(64) },
      { name: 'runs/000002.ndjson.gz', bytes: 10, sha256: 'c'.repeat(64) },
      { name: '../escape', bytes: 1, sha256: 'd'.repeat(64) },
    ],
    bundle_meta: { bundle_id: 'bundle-1', ucf_version: '0.2' },
  },
  capture_report: { cqs: 87 },
  dropped_runs: [],
  runs_ingested: 2,
};

function source(over: Partial<ExportSource> = {}): ExportSource {
  return {
    upload,
    bundleFile: async (name) => {
      if (name === 'agents.json') return enc.encode('[]');
      if (name === 'runs/000001.ndjson.gz') return (async function* () { yield enc.encode('12345'); yield enc.encode('67890'); })();
      return null; // 000002 was swept by retention
    },
    runs: async () => [
      { id: 'r1', agent_id: 'ag1', upload_id: upload.id },
      { id: 'r2', agent_id: null, upload_id: upload.id },
    ],
    turns: async (ids) => ids.flatMap((id) => [{ id: `${id}-t0`, run_id: id, content: 'hi' }]),
    artifacts: async () => [{ run_id: 'r1', path: 'a.ts' }],
    entries: async () => [{ id: 'e1', run_id: 'r1', agent_id: 'ag2', sources: [{ turn_id: 'r1-t0', ord: 0 }] }],
    agents: async (ids) => ids.map((id) => ({ id })),
    records: async () => [],
    ...over,
  };
}

async function build(src: ExportSource) {
  const buf = await zipToBuffer(composeUploadExport(src, {
    exportedBy: 'user-a', now: () => new Date('2026-09-07T14:00:00.000Z'),
  }));
  const members = readZip(buf);
  const byName = new Map(members.map((m) => [m.name, m]));
  const meta = JSON.parse(byName.get('export.json')!.data().toString()) as ExportMeta;
  return { members, byName, meta };
}

describe('composeUploadExport', () => {
  it('lays the archive out as the design note says, with export.json last', async () => {
    const { members } = await build(source());
    expect(members.map((m) => m.name)).toEqual([
      'db/runs.jsonl', 'db/turns.jsonl', 'db/artifacts.jsonl', 'db/entries.jsonl', 'db/agents.json',
      'bundle/manifest.json', 'bundle/agents.json', 'bundle/runs/000001.ndjson.gz',
      'export.json',
    ]);
  });

  it('records swept or unsafe bundle members instead of failing', async () => {
    const { meta, byName } = await build(source());
    expect(meta.missing).toEqual([
      { name: 'runs/000002.ndjson.gz', reason: 'not_found' },
      { name: '../escape', reason: 'unsafe_name' },
    ]);
    expect(byName.has('bundle/../escape')).toBe(false);
    expect(byName.get('bundle/runs/000001.ndjson.gz')!.data().toString()).toBe('1234567890');
    expect(meta.bytes.bundle).toBe(2 + 10);
  });

  it('reports counts, and never claims to be de-pseudonymised', async () => {
    const { meta } = await build(source());
    expect(meta.format).toBe(EXPORT_FORMAT);
    expect(meta.pseudonymized).toBe(true);
    expect(meta.exported_by).toBe('user-a');
    expect(meta.exported_at).toBe('2026-09-07T14:00:00.000Z');
    expect(meta.counts).toEqual({ bundle_files: 2, runs: 2, turns: 2, artifacts: 1, entries: 1, agents: 2, records: 0 });
    // manifest and capture_report live in their own members, not duplicated here
    expect((meta.upload as Record<string, unknown>).manifest).toBeUndefined();
    expect(meta.upload.id).toBe(upload.id);
  });

  it('collects agents from runs and entries, once each', async () => {
    const { byName } = await build(source());
    const agents = JSON.parse(byName.get('db/agents.json')!.data().toString()) as { id: string }[];
    expect(agents.map((a) => a.id).sort()).toEqual(['ag1', 'ag2']);
  });

  it('carries the DB copy even when Storage has nothing left', async () => {
    const { meta, byName } = await build(source({ bundleFile: async () => null }));
    expect(meta.counts.bundle_files).toBe(0);
    expect(meta.missing).toHaveLength(4);
    expect(byName.get('db/turns.jsonl')!.data().toString().split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('skips the per-run lookups when the upload ingested nothing', async () => {
    let turnsCalled = false;
    const { meta } = await build(source({
      runs: async () => [],
      turns: async () => { turnsCalled = true; return []; },
    }));
    expect(turnsCalled).toBe(false);
    expect(meta.counts.runs).toBe(0);
  });

  it('includes record files by analysis run id', async () => {
    const { byName, meta } = await build(source({
      records: async () => [{
        analysis_run_id: 'ar1', record_hash: 'h', input_hash: 'i', created_at: '2026-09-07T13:30:00.000Z',
        json: enc.encode('{}'), md: null,
      }],
    }));
    expect(byName.has('records/ar1.record.json')).toBe(true);
    expect(byName.has('records/ar1.record.md')).toBe(false);
    expect(meta.counts.records).toBe(1);
  });

  it('C7: nothing in the archive points at the corpus schema', async () => {
    const { members } = await build(source());
    expect(members.some((m) => /corpus/i.test(m.name))).toBe(false);
  });
});
