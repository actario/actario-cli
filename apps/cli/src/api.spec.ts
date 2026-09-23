import { afterEach, describe, expect, it, vi } from 'vitest';
import { DistillError } from '@distill/shared';
import { whoami } from './api.ts';

/**
 * The first wall a new person hits is a token or an API URL that is wrong.
 * These are about what they are told when that happens -- an error they can
 * act on, not one that reads like our bug.
 */

const API = { baseUrl: 'https://example.invalid', token: 'distill_pat_nope' };

const reply = (r: { ok?: boolean; status: number; statusText?: string; json: () => Promise<unknown> }) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: r.ok ?? false,
    status: r.status,
    statusText: r.statusText ?? '',
    json: r.json,
  })));

const caught = async (): Promise<DistillError> => {
  try {
    await whoami(API);
  } catch (e) {
    return e as DistillError;
  }
  throw new Error('expected whoami to throw');
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('4xx without the app error envelope', () => {
  it('reports a rejected token as forbidden, and says what to do', async () => {
    reply({ status: 403, statusText: 'Forbidden', json: async () => ({}) });
    const e = await caught();
    expect(e).toBeInstanceOf(DistillError);
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain(API.baseUrl);
    expect(e.message).toContain('token');
    expect(e.message).toContain('Access tokens');
    // The thing this test exists to prevent.
    expect(e.code).not.toBe('internal');
  });

  it('reports 401 the same way', async () => {
    reply({ status: 401, statusText: 'Unauthorized', json: async () => ({}) });
    expect((await caught()).code).toBe('unauthorized');
  });

  it('points a 404 at the API URL rather than the token', async () => {
    reply({ status: 404, statusText: 'Not Found', json: async () => ({}) });
    const e = await caught();
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('API URL');
  });
});

describe('4xx with the app error envelope', () => {
  it('keeps the server code and message, which are more specific', async () => {
    reply({
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: { code: 'byok_invalid', message: 'The workspace key was rejected.' } }),
    });
    const e = await caught();
    expect(e.code).toBe('byok_invalid');
    expect(e.message).toBe('The workspace key was rejected.');
  });
});

describe('a 200 that is not JSON', () => {
  it('names the URL instead of surfacing a parse error', async () => {
    reply({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    const e = await caught();
    expect(e).toBeInstanceOf(DistillError);
    expect(e.message).toContain('not JSON');
    expect(e.message).toContain(API.baseUrl);
    expect(e.message).not.toContain('Unexpected token');
  });
});
