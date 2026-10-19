import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyHash, newVaultKey, openBody, sealBody, vaultFrom } from './messages-vault.ts';

const r = { client_msg_id: 'abcdefgh12', from: 'kestrel/backend', to: 'kestrel/frontend', kind: 'command' as const };
const body = { subject: 'Update the types', body: 'The /runs response has turns_count now.', capabilities: ['edit' as const] };

describe('actario.msg/v2: bodies sealed with the server key', () => {
  it('seals and opens; the stored form holds no plaintext', () => {
    const v = vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey('k1') });
    const s = sealBody(v, r, body);
    expect(s.sealed).toMatch(/^v2\.k1\./);
    expect(s.sealed).not.toContain('turns_count');
    expect(s.key_id).toBe('k1');
    expect(s.body_sha256).toBe(bodyHash(v, body));
    expect(s.body_sha256).not.toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    expect(openBody(v, r, s.sealed)).toEqual(body);
  });

  it('a body cannot be moved onto another message: the routing is bound in', () => {
    const v = vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey() });
    const s = sealBody(v, r, body);
    expect(() => openBody(v, { ...r, to: 'kestrel/docs' }, s.sealed)).toThrow(/could not be opened/);
    expect(() => openBody(v, { ...r, kind: 'note' }, s.sealed)).toThrow(/could not be opened/);
  });

  it('rotation: an old key still opens, only the current one seals', () => {
    const old = newVaultKey('k1');
    const before = vaultFrom({ ACTARIO_MESSAGES_KEY: old });
    const sealedOld = sealBody(before, r, body).sealed;
    const after = vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey('k2'), ACTARIO_MESSAGES_KEYS_OLD: old });
    expect(openBody(after, r, sealedOld)).toEqual(body);
    expect(sealBody(after, r, body).key_id).toBe('k2');
    expect(() => openBody(vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey('k3') }), r, sealedOld)).toThrow(/no longer has/);
  });

  it('no key configured: sealing is refused with a 503, nothing half-written', () => {
    const v = vaultFrom({});
    expect(() => sealBody(v, r, body)).toThrow(expect.objectContaining({ code: 'messages_unavailable', httpStatus: 503 }));
  });

  it('a malformed key is refused at startup, not used', () => {
    expect(() => vaultFrom({ ACTARIO_MESSAGES_KEY: 'k1:short' })).toThrow(/32 bytes/);
  });

  it('the same body hashes the same regardless of key order, and differently under another key', () => {
    const v = vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey() });
    expect(bodyHash(v, { body: 'b', subject: 's' })).toBe(bodyHash(v, { subject: 's', body: 'b' }));
    expect(bodyHash(vaultFrom({ ACTARIO_MESSAGES_KEY: newVaultKey() }), { subject: 's', body: 'b' })).not.toBe(bodyHash(v, { subject: 's', body: 'b' }));
  });
});
