import { inflateRawSync } from 'node:zlib';

/**
 * Minimal zip writer and reader, dependency-free like the reader in
 * packages/adapters (which is read-only and positional, tuned for
 * multi-gigabyte account exports; this one is tuned for producing an archive
 * we never have to hold in memory).
 *
 * Writer properties:
 *   - streaming: entries are pulled from an async iterable and emitted as
 *     chunks; sizes and CRCs are written in a data descriptor after each
 *     entry (general-purpose bit 3), so nothing needs to be known up front
 *   - stored only (method 0): the bundle parts are already gzip, the JSONL
 *     files are small, and a deflate stream would buy little for the cost
 *   - UTF-8 names (bit 11), no ZIP64. One upload is at most 2000 files of
 *     ≤ 32 MB each; the design note records the 4 GB ceiling explicitly
 *
 * The reader is for tests and for `actario unmask`, which walks an archive
 * this writer produced. It reads a whole Buffer: exports are bounded by the
 * same 4 GB, and unmask is an explicit local step, not a hot path.
 */

export interface ZipEntry {
  /** Forward slashes, no leading slash. */
  name: string;
  data: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  mtime?: Date;
}

const LOCAL_SIG = 0x0403_4b50;
const DESC_SIG = 0x0807_4b50;
const CDIR_SIG = 0x0201_4b50;
const EOCD_SIG = 0x0605_4b50;
const FLAGS = 0x0808; // bit 3: data descriptor; bit 11: UTF-8 names
const VERSION = 20;

// ── CRC-32 (IEEE), table-driven ──
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

interface Written {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

const u16 = (b: Buffer, o: number, v: number) => b.writeUInt16LE(v & 0xffff, o);
const u32 = (b: Buffer, o: number, v: number) => b.writeUInt32LE(v >>> 0, o);

function localHeader(nameBytes: Uint8Array, time: number, date: number): Buffer {
  const b = Buffer.alloc(30 + nameBytes.length);
  u32(b, 0, LOCAL_SIG); u16(b, 4, VERSION); u16(b, 6, FLAGS); u16(b, 8, 0);
  u16(b, 10, time); u16(b, 12, date);
  u32(b, 14, 0); u32(b, 18, 0); u32(b, 22, 0); // crc, csize, size: in the descriptor
  u16(b, 26, nameBytes.length); u16(b, 28, 0);
  b.set(nameBytes, 30);
  return b;
}

function descriptor(crc: number, size: number): Buffer {
  const b = Buffer.alloc(16);
  u32(b, 0, DESC_SIG); u32(b, 4, crc); u32(b, 8, size); u32(b, 12, size);
  return b;
}

function centralEntry(w: Written): Buffer {
  const b = Buffer.alloc(46 + w.nameBytes.length);
  u32(b, 0, CDIR_SIG); u16(b, 4, VERSION); u16(b, 6, VERSION); u16(b, 8, FLAGS); u16(b, 10, 0);
  u16(b, 12, w.time); u16(b, 14, w.date);
  u32(b, 16, w.crc); u32(b, 20, w.size); u32(b, 24, w.size);
  u16(b, 28, w.nameBytes.length); u16(b, 30, 0); u16(b, 32, 0);
  u16(b, 34, 0); u16(b, 36, 0); u32(b, 38, 0);
  u32(b, 42, w.offset);
  b.set(w.nameBytes, 46);
  return b;
}

function eocd(count: number, cdSize: number, cdOffset: number): Buffer {
  const b = Buffer.alloc(22);
  u32(b, 0, EOCD_SIG); u16(b, 4, 0); u16(b, 6, 0); u16(b, 8, count); u16(b, 10, count);
  u32(b, 12, cdSize); u32(b, 16, cdOffset); u16(b, 20, 0);
  return b;
}

const isBytes = (d: ZipEntry['data']): d is Uint8Array => d instanceof Uint8Array;

/**
 * Streams a zip archive from `entries`. Consumers may wrap the generator in a
 * ReadableStream (the web route) or write chunks to a file (tests, CLI).
 */
export async function* writeZip(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  let offset = 0;
  const MAX = 0xffff_ffff;

  for await (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.includes('..')) {
      throw new Error(`unsafe zip entry name: ${entry.name}`);
    }
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const start = offset;

    const head = localHeader(nameBytes, time, date);
    yield head; offset += head.length;

    let crc = 0;
    let size = 0;
    const chunks = isBytes(entry.data) ? [entry.data] : entry.data;
    for await (const chunk of chunks) {
      if (chunk.length === 0) continue;
      crc = crc32(chunk, crc);
      size += chunk.length;
      if (size > MAX) throw new Error(`zip entry too large for a non-ZIP64 archive: ${entry.name}`);
      yield chunk; offset += chunk.length;
    }

    const desc = descriptor(crc, size);
    yield desc; offset += desc.length;
    written.push({ nameBytes, crc, size, offset: start, time, date });
    if (offset > MAX) throw new Error('zip archive exceeds the non-ZIP64 4 GB ceiling');
  }

  if (written.length > 0xffff) throw new Error('too many entries for a non-ZIP64 archive');
  const cdStart = offset;
  for (const w of written) {
    const c = centralEntry(w);
    yield c; offset += c.length;
  }
  yield eocd(written.length, offset - cdStart, cdStart);
}

/** Collects a whole archive into one Buffer. Tests and small archives only. */
export async function zipToBuffer(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of writeZip(entries)) parts.push(c);
  return Buffer.concat(parts);
}

// ── reader ──

export interface ZipMember {
  name: string;
  method: number;
  size: number;
  crc: number;
  data: () => Buffer;
}

export function readZip(buf: Buffer): ZipMember[] {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { e = i; break; }
  }
  if (e < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(e + 10);
  const cdSize = buf.readUInt32LE(e + 12);
  const cdOffset = buf.readUInt32LE(e + 16);

  const members: ZipMember[] = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= cdOffset + cdSize; i++) {
    if (buf.readUInt32LE(p) !== CDIR_SIG) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    members.push({
      name, method, size, crc,
      data: () => {
        if (buf.readUInt32LE(offset) !== LOCAL_SIG) throw new Error(`bad local header for ${name}`);
        const n = buf.readUInt16LE(offset + 26);
        const x = buf.readUInt16LE(offset + 28);
        const start = offset + 30 + n + x;
        const raw = buf.subarray(start, start + csize);
        const out = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
        if (!out) throw new Error(`unsupported compression method ${method} for ${name}`);
        if (crc32(out) !== crc) throw new Error(`crc mismatch for ${name}`);
        return out;
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}
