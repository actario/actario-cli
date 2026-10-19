import { open, type FileHandle } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

/**
 * Minimal zip reader for account-export archives.
 *
 * Deliberately dependency-free: an export zip is a plain stored/deflated
 * archive, and shipping a zip library to every user machine costs more than
 * the code below.
 *
 * Reads are positional. The first version loaded the whole file with
 * readFile() to find the central directory, which is fine for a 2 MB fixture
 * and not fine for a real ChatGPT export -- those run to hundreds of megabytes
 * and Node's buffer ceiling makes multi-gigabyte ones fail outright. Only the
 * tail, the central directory, and the one member actually wanted are ever
 * read into memory.
 */

interface Entry {
  name: string;
  offset: number;
  method: number;
  size: number;
  csize: number;
}

const EOCD_SIG = 0x0605_4b50;
const EOCD64_LOCATOR_SIG = 0x0706_4b50;
const CDIR_SIG = 0x0201_4b50;
const LOCAL_SIG = 0x0403_4b50;
const MAX_COMMENT = 65_557;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

async function locateCentralDirectory(fh: FileHandle, fileSize: number) {
  const tailLen = Math.min(MAX_COMMENT, fileSize);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');

  let count = tail.readUInt16LE(eocd + 10);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let cdSize = tail.readUInt32LE(eocd + 12);

  // ZIP64: a real export can exceed 65,535 entries or 4 GB, and the 32-bit
  // fields are then sentinels pointing at the ZIP64 record.
  if (count === 0xffff || cdOffset === 0xffff_ffff || cdSize === 0xffff_ffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD64_LOCATOR_SIG) continue;
      const eocd64Offset = Number(tail.readBigUInt64LE(i + 8));
      const rec = await readAt(fh, eocd64Offset, 56);
      if (rec.readUInt32LE(0) !== 0x0606_4b50) break;
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
      break;
    }
  }
  return { count, cdOffset, cdSize };
}

async function readEntries(fh: FileHandle, fileSize: number): Promise<Entry[]> {
  const { count, cdOffset, cdSize } = await locateCentralDirectory(fh, fileSize);
  const cd = await readAt(fh, cdOffset, cdSize);

  const entries: Entry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CDIR_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, offset, method, size, csize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extract(fh: FileHandle, entry: Entry): Promise<Buffer> {
  const header = await readAt(fh, entry.offset, 30);
  if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = header.readUInt16LE(26);
  const extraLen = header.readUInt16LE(28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = await readAt(fh, start, entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

const matches = (name: string, member: string) =>
  name === member || name.endsWith(`/${member}`);

/**
 * Is `member` in this archive? Cheap: reads the tail and the central
 * directory, never a member. Used by detect() so a source is recognised by
 * what it contains rather than by what it is called.
 */
export async function zipHasMember(path: string, member: string): Promise<boolean> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    const entries = await readEntries(fh, size);
    return entries.some((e) => matches(e.name, member));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/** Entry count, for diagnostics. Returns null when the file is not a zip. */
export async function zipEntryCount(path: string): Promise<number | null> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    return (await readEntries(fh, size)).length;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/**
 * Reads `member` out of a zip, or reads the file directly when the path is
 * already the unpacked JSON. Callers pass either shape: people unpack exports
 * about half the time and should not have to care.
 */
export async function readJsonFromZipOrFile<T>(path: string, member: string): Promise<T | null> {
  if (!path.toLowerCase().endsWith('.zip')) {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const buf = await readAt(fh, 0, size);
      return JSON.parse(buf.toString('utf8')) as T;
    } finally {
      await fh.close();
    }
  }

  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const entries = await readEntries(fh, size);
    const hit = entries.find((e) => matches(e.name, member));
    if (!hit) return null;
    return JSON.parse((await extract(fh, hit)).toString('utf8')) as T;
  } finally {
    await fh.close();
  }
}

export async function listZipEntries(path: string): Promise<string[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    return (await readEntries(fh, size)).map((e) => e.name);
  } finally {
    await fh.close();
  }
}
