import { hmacShort } from '@distill/shared';
import type { RedactionRule } from './types.ts';

/**
 * Stable pseudonyms, not [REDACTED] (5.6 of the plan, 6.5 of the architecture).
 *
 * `HMAC(local_salt, normalised_value)` truncated. Two consequences, both
 * intended:
 *   - The same email captured in March and in September gets the same token,
 *     so entity linking on the server still works across time.
 *   - The salt lives in ~/.actario/salt and is never uploaded, so the server
 *     cannot reverse a token even with the full corpus.
 */
export function normaliseValue(value: string): string {
  return value.trim().toLowerCase();
}

export function pseudonymFor(rule: RedactionRule, value: string, salt: string): string {
  return `${rule.prefix}-${hmacShort(salt, `${rule.prefix}:${normaliseValue(value)}`)}`;
}
