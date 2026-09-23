import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isTextMember, reverseMap, unmaskMember, unmaskMembers, unmaskText, type RedactionMapFile } from './unmask.ts';

const map: RedactionMapFile = {
  version: 1,
  entries: [
    { original: 'jacky@example.test', pseudonym: 'EMAIL-A1B2C3' },
    { original: 'sk-ant-api03-verysecret', pseudonym: 'KEY-0F0F0F' },
    { original: '+886 912 345 678', pseudonym: 'PHONE-12AB34' },
    // A pseudonym that is a prefix of another must not clobber it.
    { original: 'short', pseudonym: 'IP-ABCDEF' },
    { original: 'long', pseudonym: 'IP-ABCDEF0' },
  ],
};
const rev = reverseMap(map);

describe('unmaskText', () => {
  it('replaces every occurrence and counts per rule prefix', () => {
    const { text, report } = unmaskText('mail EMAIL-A1B2C3 twice EMAIL-A1B2C3; key KEY-0F0F0F', rev);
    expect(text).toBe('mail jacky@example.test twice jacky@example.test; key sk-ant-api03-verysecret');
    expect(report.replaced).toEqual({ EMAIL: 2, KEY: 1 });
    expect(report.unknown).toBe(0);
  });

  it('applies longer pseudonyms first', () => {
    const { text } = unmaskText('IP-ABCDEF0 and IP-ABCDEF', rev);
    expect(text).toBe('long and short');
  });

  it('reports pseudonyms this machine cannot reverse without guessing', () => {
    const { text, report } = unmaskText('from elsewhere: EMAIL-FFFFFF, GOVID-123456', rev);
    expect(text).toContain('EMAIL-FFFFFF');
    expect(report.unknown).toBe(2);
    expect(report.unknown_samples).toEqual(['EMAIL-FFFFFF', 'GOVID-123456']);
  });

  it('does not mistake ordinary identifiers for pseudonyms', () => {
    const { report } = unmaskText('UUID-abcdef is lower-case; MODEL-4 is short; ABC-12345 is five', rev);
    expect(report.unknown).toBe(0);
  });

  it('with an empty map, changes nothing and still counts', () => {
    const { text, report } = unmaskText('EMAIL-A1B2C3', new Map());
    expect(text).toBe('EMAIL-A1B2C3');
    expect(report.unknown).toBe(1);
  });
});

describe('unmaskMember', () => {
  it('rewrites gzip members and re-compresses them', () => {
    const data = gzipSync(Buffer.from('{"content":"EMAIL-A1B2C3"}\n'));
    const { member, report } = unmaskMember({ name: 'bundle/runs/000001.ndjson.gz', data }, rev);
    expect(gunzipSync(member.data).toString()).toBe('{"content":"jacky@example.test"}\n');
    expect(report.replaced).toEqual({ EMAIL: 1 });
  });

  it('copies non-text members byte for byte', () => {
    const data = new Uint8Array([0x45, 0x4d, 0x41, 0x49, 0x4c]);
    const { member, report } = unmaskMember({ name: 'blob.bin', data }, rev);
    expect(member.data).toBe(data);
    expect(report.replaced).toEqual({});
  });

  it('knows which names are text', () => {
    expect(isTextMember('db/turns.jsonl')).toBe(true);
    expect(isTextMember('records/x.record.md')).toBe(true);
    expect(isTextMember('bundle/runs/000001.ndjson.gz')).toBe(true);
    expect(isTextMember('image.png')).toBe(false);
    expect(isTextMember('archive.tar.gz')).toBe(false);
  });
});

describe('unmaskMembers', () => {
  it('merges reports across the archive', () => {
    const { members, report } = unmaskMembers([
      { name: 'db/turns.jsonl', data: Buffer.from('EMAIL-A1B2C3 PHONE-12AB34\n') },
      { name: 'db/entries.jsonl', data: Buffer.from('EMAIL-A1B2C3 EMAIL-FFFFFF\n') },
    ], rev);
    expect(members).toHaveLength(2);
    expect(report.replaced).toEqual({ EMAIL: 2, PHONE: 1 });
    expect(report.unknown).toBe(1);
  });
});
