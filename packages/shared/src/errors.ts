/**
 * Error codes are part of the API contract: the frontend maps them to an
 * actionable message, never a stack trace (arch 8.4). Adding a code means
 * adding a user-facing sentence for it.
 */
export const ERROR_CODES = [
  'manifest_mismatch',      // /complete: declared files != stored objects (7.2)
  'bundle_too_large',
  'byok_invalid',           // 8.4
  'byok_missing',
  'adapter_failed',         // whole source failed; other sources continue (C5)
  'run_quarantined',        // single run blew up; batch continues (C5)
  'cqs_rejected',           // CQS < 40, refused before upload (6.1 step 6)
  'invalid_request',        // body failed the zod contract (route.ts maps ZodError here too)
  'daf_invalid',            // POST /uploads/{id}/analysis: the DAF failed its schema (arch v1.3 18.5 rule 1)
  'bundle_mismatch',        // the DAF names a bundle other than this upload's (18.5 rule 2)
  'upload_not_ready',       // ingest has not finished: the runs the anchors point at do not exist yet
  'daf_too_large',
  'no_visible_source',      // confirming an entry whose source turns the caller cannot see (C1 + C8, arch v1.3 18.6)
  'seats_exhausted',        // an invitation would exceed the org's seats: add seats or revoke an invitation
  'last_admin',             // an organization must keep at least one admin
  'last_superuser',         // the last platform superuser cannot be removed from the web
  'invitation_invalid',     // the invitation was revoked, accepted or has expired
  'page_conflict',          // the note page was saved by someone else since it was opened: reload, then edit (design 0002)
  'plan_required',          // the workspace's plan does not include this (e.g. full export on Free)
  'billing_not_configured', // no billing provider keys on this deployment yet (Stripe not connected)
  // Sign in from Claude (device authorization, RFC 8628 names):
  'authorization_pending',  // the person has not approved the sign-in yet: keep polling
  'slow_down',              // polled faster than the interval: add 5 s and keep polling
  'access_denied',          // the person said no (or left the workspace): start over
  'expired_token',          // the request timed out or was already used: start over
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DistillError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'DistillError';
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const unauthorized = (m = 'Missing or invalid credentials') =>
  new DistillError('unauthorized', m, undefined, 401);
export const forbidden = (m = 'Not permitted') =>
  new DistillError('forbidden', m, undefined, 403);
export const notFound = (m = 'Not found') =>
  new DistillError('not_found', m, undefined, 404);
export const conflict = (m: string, details?: unknown) =>
  new DistillError('conflict', m, details, 409);

/** 422: the request is well-formed but the state it asks for is not allowed. */
export const unprocessable = (code: ErrorCode, m: string, details?: unknown) =>
  new DistillError(code, m, details, 422);
