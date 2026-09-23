import { describe, expect, it } from 'vitest';
import { REVIEW_POLICY_VERSIONS, entryLanding } from './entries.ts';

describe('entryLanding (C8 review policy)', () => {
  it('allow_all confirms on arrival and says which policy did it', () => {
    expect(entryLanding('allow_all')).toEqual({
      status: 'confirmed', review_source: 'policy', review_version: REVIEW_POLICY_VERSIONS.allow_all,
    });
  });

  it('human leaves the claim pending for the Inbox', () => {
    expect(entryLanding('human')).toEqual({ status: 'pending', review_source: null, review_version: null });
  });

  it('fails closed on anything it does not recognise', () => {
    for (const p of [null, undefined, '', 'program', 'ALLOW_ALL', 'allow_all ']) {
      expect(entryLanding(p).status).toBe('pending');
    }
  });
});
