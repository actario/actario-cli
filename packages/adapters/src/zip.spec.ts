import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { listZipEntries, readJsonFromZipOrFile, zipEntryCount, zipHasMember } from './zip.ts';

/**
 * The zip reader exists so the CLI does not ship a zip library to every user
 * machine. These tests pin the two properties that matter: it reads only what
 * it needs, and it tells the truth about what an archive contains.
 *
 * The second one is why the detectors were rewritten. Matching `*claude*.zip`
 * on the filename claimed an ordinary project archive as a Claude export, and
 * a detector that reports "found" for something that can never yield a
 * conversation makes doctor worse than useless.
 */

/** Minimal zip writer: enough to build fixtures without a dependency. */
function makeZip(entries: { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const stored = e.store === true;
    const body = stored ? raw : deflateRawSync(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt32LE(0, 14);            // crc: unchecked by the reader
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const dir = mkdtempSync(join(tmpdir(), 'distill-zip-'));
const write = (name: string, buf: Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
};

const conversations = [{ conversation_id: 'c1', mapping: {}, title: 'x' }];

const exportZip = write('export.zip', makeZip([
  { name: 'conversations.json', data: JSON.stringify(conversations) },
  { name: 'user.json', data: '{"email":"x@y.z"}' },
]));

// The archive that broke filename-based detection on a real machine.
const decoyZip = write('bp_prediction_pipeline_RF_claude.zip', makeZip([
  { name: 'model.pkl', data: Buffer.alloc(2048), store: true },
  { name: 'train.py', data: 'import sklearn\n' },
]));

const nestedZip = write('nested.zip', makeZip([
  { name: 'chatgpt-export/conversations.json', data: JSON.stringify(conversations) },
]));

describe('zipHasMember', () => {
  it('finds a member at the root', async () => {
    expect(await zipHasMember(exportZip, 'conversations.json')).toBe(true);
  });

  it('finds a member nested one folder deep, which is how exports often unpack', async () => {
    expect(await zipHasMember(nestedZip, 'conversations.json')).toBe(true);
  });

  it('rejects an archive that merely has the word in its filename', async () => {
    expect(await zipHasMember(decoyZip, 'conversations.json')).toBe(false);
  });

  it('returns false rather than throwing on a file that is not a zip', async () => {
    const notZip = write('notes.txt', Buffer.from('hello'));
    expect(await zipHasMember(notZip, 'conversations.json')).toBe(false);
  });
});

describe('reading members', () => {
  it('extracts and parses a deflated member', async () => {
    const parsed = await readJsonFromZipOrFile<typeof conversations>(exportZip, 'conversations.json');
    expect(parsed?.[0]?.conversation_id).toBe('c1');
  });

  it('returns null when the member is absent, instead of failing the capture', async () => {
    expect(await readJsonFromZipOrFile(decoyZip, 'conversations.json')).toBeNull();
  });

  it('reads a bare unpacked json file too -- people unpack exports half the time', async () => {
    const bare = write('conversations.json', Buffer.from(JSON.stringify(conversations)));
    const parsed = await readJsonFromZipOrFile<typeof conversations>(bare, 'conversations.json');
    expect(parsed?.[0]?.title).toBe('x');
  });

  it('handles stored (uncompressed) entries', async () => {
    const storedZip = write('stored.zip', makeZip([
      { name: 'conversations.json', data: JSON.stringify(conversations), store: true },
    ]));
    const parsed = await readJsonFromZipOrFile<typeof conversations>(storedZip, 'conversations.json');
    expect(parsed?.[0]?.conversation_id).toBe('c1');
  });
});

describe('diagnostics', () => {
  it('counts entries, for the "detected but zero units" case', async () => {
    expect(await zipEntryCount(exportZip)).toBe(2);
    expect(await zipEntryCount(join(dir, 'nope.zip'))).toBeNull();
  });

  it('lists entry names', async () => {
    expect(await listZipEntries(exportZip)).toEqual(['conversations.json', 'user.json']);
  });
});
