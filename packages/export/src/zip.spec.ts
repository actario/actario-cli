import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, readZip, zipToBuffer, type ZipEntry } from './zip.ts';

const enc = new TextEncoder();
async function* chunks(...parts: string[]) { for (const p of parts) yield enc.encode(p); }

describe('crc32', () => {
  it('matches the reference value for "123456789"', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf4_3926);
  });
  it('is incremental', () => {
    const a = enc.encode('hello, ');
    const b = enc.encode('world');
    expect(crc32(b, crc32(a))).toBe(crc32(enc.encode('hello, world')));
  });
});

describe('writeZip / readZip round trip', () => {
  it('stores bytes, streamed entries and UTF-8 names, and reads them back', async () => {
    const entries: ZipEntry[] = [
      { name: 'export.json', data: enc.encode('{"a":1}\n') },
      { name: 'bundle/runs/000001.ndjson.gz', data: chunks('line1\n', 'line2\n', '') },
      { name: 'db/空的.jsonl', data: new Uint8Array(0) },
    ];
    const buf = await zipToBuffer(entries);
    const members = readZip(buf);
    expect(members.map((m) => m.name)).toEqual(['export.json', 'bundle/runs/000001.ndjson.gz', 'db/空的.jsonl']);
    expect(members[0]!.data().toString()).toBe('{"a":1}\n');
    expect(members[1]!.data().toString()).toBe('line1\nline2\n');
    expect(members[2]!.size).toBe(0);
    expect(members.every((m) => m.method === 0)).toBe(true);
  });

  it('writes an empty archive that is still a valid zip', async () => {
    const buf = await zipToBuffer([]);
    expect(buf.length).toBe(22);
    expect(readZip(buf)).toEqual([]);
  });

  it('refuses names that could escape an extraction directory', async () => {
    await expect(zipToBuffer([{ name: '../x', data: new Uint8Array(0) }])).rejects.toThrow(/unsafe/);
    await expect(zipToBuffer([{ name: '/abs', data: new Uint8Array(0) }])).rejects.toThrow(/unsafe/);
    await expect(zipToBuffer([{ name: 'a\\b', data: new Uint8Array(0) }])).rejects.toThrow(/unsafe/);
  });

  it('detects corruption through the stored crc', async () => {
    const buf = await zipToBuffer([{ name: 'a.txt', data: enc.encode('payload') }]);
    const i = 30 + 'a.txt'.length; // first data byte
    buf.writeUInt8(buf.readUInt8(i) ^ 0xff, i);
    expect(() => readZip(buf)[0]!.data()).toThrow(/crc mismatch/);
  });

  it('is accepted by the system unzip when one is installed', async () => {
    let unzip: string | null = null;
    try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); unzip = 'unzip'; } catch { /* not installed */ }
    if (!unzip) return;
    const dir = mkdtempSync(join(tmpdir(), 'distill-zip-'));
    const path = join(dir, 't.zip');
    writeFileSync(path, await zipToBuffer([
      { name: 'export.json', data: enc.encode('{}\n') },
      { name: 'bundle/runs/000001.ndjson.gz', data: chunks('x'.repeat(70_000)) },
    ]));
    // -t tests every member's crc; a non-zero exit throws.
    const out = execFileSync(unzip, ['-t', path]).toString();
    expect(out).toMatch(/No errors detected/);
  });
});
