import { describe, expect, it } from 'vitest';
import {
  deviceFingerprint, generateDeviceKeys, openMessage, safetyNumber, sealMessage, verifyMessage, type DevicePrivateKeys,
} from './messages-crypto.ts';

/**
 * actario.msg/v1 (arch v3.0 24.7, 24.15): what the platform stores verifies
 * against the sending device, opens on each device it was sealed for, and on
 * nothing else; any change to routing, keys or ciphertext breaks the
 * signature or the decryption.
 */
const dev = (id: string) => ({ id, keys: generateDeviceKeys() });
const pub = (d: { id: string; keys: DevicePrivateKeys }) => ({ id: d.id, x25519_pub: d.keys.x25519_pub, ed25519_pub: d.keys.ed25519_pub });
const A = dev('aaaaaaaa-0000-4000-8000-000000000001');
const B = dev('bbbbbbbb-0000-4000-8000-000000000002');
const C = dev('cccccccc-0000-4000-8000-000000000003');

const sealed = () => sealMessage({
  client_msg_id: 'msg-test-0001', from: 'jacky/backend', to: 'jacky/frontend', kind: 'command',
  body: { subject: 'Update the types', body: 'The response shape changed.', capabilities: ['edit', 'run_tests'] },
  sender: { device_id: A.id, keys: A.keys }, devices: [pub(A), pub(B)],
});

describe('seal, verify, open', () => {
  it('opens on every device it was sealed for, and verifies against the sender', () => {
    const s = sealed();
    expect(verifyMessage(s, A.keys.ed25519_pub)).toBe(true);
    expect(openMessage(s, { device_id: B.id, keys: B.keys })).toMatchObject({ subject: 'Update the types', capabilities: ['edit', 'run_tests'] });
    expect(openMessage(s, { device_id: A.id, keys: A.keys }).body).toBe('The response shape changed.');
    expect(s.envelope.keys.map((k) => k.device).sort()).toEqual([A.id, B.id]);
    expect(JSON.stringify(s)).not.toContain('response shape');
  });

  it('a device it was not sealed for cannot open it -- not even with a sealed device\'s id', () => {
    const s = sealed();
    expect(() => openMessage(s, { device_id: C.id, keys: C.keys })).toThrow(/not sealed for this computer/);
    expect(() => openMessage(s, { device_id: B.id, keys: C.keys })).toThrow(/could not be opened/);
  });

  it('another key does not verify; changed routing, kind, keys or ciphertext do not verify', () => {
    const s = sealed();
    expect(verifyMessage(s, C.keys.ed25519_pub)).toBe(false);
    expect(verifyMessage({ ...s, to: 'jacky/other' }, A.keys.ed25519_pub)).toBe(false);
    expect(verifyMessage({ ...s, kind: 'note' }, A.keys.ed25519_pub)).toBe(false);
    expect(verifyMessage({ ...s, envelope: { ...s.envelope, keys: s.envelope.keys.slice(0, 1) } }, A.keys.ed25519_pub)).toBe(false);
    const flipped = Buffer.from(s.ciphertext, 'base64url'); flipped[0] = flipped[0]! ^ 1;
    expect(verifyMessage({ ...s, ciphertext: flipped.toString('base64url') }, A.keys.ed25519_pub)).toBe(false);
  });

  it('the ciphertext is bound to its routing: moved onto another address it does not open', () => {
    const s = sealed();
    expect(() => openMessage({ ...s, to: 'jacky/elsewhere' }, { device_id: B.id, keys: B.keys })).toThrow();
  });

  it('refuses more than 64 KB', () => {
    expect(() => sealMessage({
      client_msg_id: 'msg-test-0002', from: 'jacky/a', to: 'jacky/b', kind: 'note',
      body: { subject: 's', body: 'x'.repeat(60_000) + 'y'.repeat(10) }, sender: { device_id: A.id, keys: A.keys }, devices: [pub(A)],
    })).toThrow();
  });
});

describe('fingerprints', () => {
  it('a fingerprint is 40 hex, stable, and changes with either key', () => {
    const f = deviceFingerprint(A.keys);
    expect(f).toMatch(/^[0-9a-f]{40}$/);
    expect(deviceFingerprint(A.keys)).toBe(f);
    expect(deviceFingerprint({ ...A.keys, x25519_pub: B.keys.x25519_pub })).not.toBe(f);
  });

  it('a safety number does not depend on order', () => {
    const fa = deviceFingerprint(A.keys); const fb = deviceFingerprint(B.keys);
    expect(safetyNumber([fa, fb])).toBe(safetyNumber([fb, fa]));
    expect(safetyNumber([fa, fb])).toMatch(/^(\d{5} ){7}\d{5}$/);
  });
});
