import type { Match, RedactionRule } from './types.ts';

const byRegex = (re: RegExp) => (text: string): Match[] => {
  const out: Match[] = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(rx)) {
    if (m.index == null) continue;
    // Group 1, when present, is the part to replace: it lets a rule anchor on
    // surrounding context ("password=") without redacting the context itself.
    const value = m[1] ?? m[0];
    const start = m[1] != null ? m.index + m[0].indexOf(m[1]) : m.index;
    out.push({ start, end: start + value.length, value });
  }
  return out;
};

const both: RedactionRule['profile'] = ['medical', 'general'];

/**
 * Does this look like a secret VALUE, or like code that refers to one?
 *
 * With v1.2 widening the upload scope, tool params and diff bodies carry
 * source code, and source code about credentials is full of lines like
 * `token: process.env.DISTILL_TOKEN` or `key = SUPABASE_SERVICE_ROLE_KEY`. The
 * generic assignment rule matched all of them -- 49 hits on one machine's
 * sessions of THIS repository -- and, being a hard rule, rewrote them to
 * `KEY-xxxxxx` in the uploaded code. That is the ADR 14 failure again:
 * over-redaction destroys the record and nobody is told.
 *
 * The discriminator is cheap: a real credential essentially always contains a
 * digit or base64 punctuation; an identifier path (`a.b.C_D`) never does. A
 * lowercase dictionary-word password with no digits is the case this misses,
 * and that is the right side to miss on for a rule that cannot be disabled.
 */
const looksLikeSecretValue = (v: string): boolean => /[0-9+/=]/.test(v);

/**
 * ── Hard rules (C6) ──────────────────────────────────────────────────────
 * Credential shapes. Unconditional, in both profiles, and --no-redact does
 * not reach them. Every one of these has a fixture in
 * __fixtures__/must-catch/, and a miss fails CI (arch 14).
 */
const HARD_RULES: RedactionRule[] = [
  {
    id: 'aws_access_key_id',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/),
    description: 'AWS access key id',
  },
  {
    id: 'aws_secret_access_key',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/i),
    description: 'AWS secret access key',
  },
  {
    id: 'anthropic_api_key',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\bsk-ant-[A-Za-z0-9_-]{16,}/),
    description: 'Anthropic API key',
  },
  {
    id: 'openai_api_key',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/),
    description: 'OpenAI API key',
  },
  {
    id: 'github_token',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/),
    description: 'GitHub personal access token',
  },
  {
    id: 'google_api_key',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\bAIza[0-9A-Za-z_-]{35}\b/),
    description: 'Google API key',
  },
  {
    id: 'slack_token',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\bxox[abposr]-[A-Za-z0-9-]{10,}/),
    description: 'Slack token',
  },
  {
    id: 'stripe_secret_key',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/),
    description: 'Stripe secret key',
  },
  {
    id: 'supabase_service_role_jwt',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/),
    description: 'JWT (includes Supabase anon/service_role keys)',
  },
  {
    id: 'db_connection_string',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: byRegex(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@[^\s"'`]+/),
    description: 'database connection string with an inline password',
  },
  {
    id: 'private_key_block',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    // Non-greedy across lines: one block at a time, header included.
    find: byRegex(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/),
    description: 'PEM private key block',
  },
  {
    id: 'generic_secret_assignment',
    profile: both, category: 'secret', hard: true, prefix: 'KEY',
    find: (text) => byRegex(
      /(?:api[_-]?key|secret|password|passwd|token|bearer|client[_-]?secret)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{12,})["']?/i,
    )(text).filter((m) => looksLikeSecretValue(m.value)),
    description: 'secret-shaped assignment (api_key=, password:, bearer ...)',
  },
  {
    id: 'payment_card_number',
    // Category is pii, but the flag is hard: the cost of leaking a card number
    // is as asymmetric as a credential's, so it gets a credential's treatment.
    profile: both, category: 'pii', hard: true, prefix: 'CARD',
    /**
     * Luhn alone is not a filter: roughly one in ten random digit runs passes
     * it, and a long session log is full of long digit runs. On one real
     * session that produced 16 false positives.
     *
     * A card number therefore has to look like one as well as check out:
     * either separated 4-digit groups, or an unbroken run carrying a real
     * issuer prefix. This is a hard rule, so a false positive silently mangles
     * data the user cannot get back -- the precision matters more here than in
     * any soft rule.
     */
    find: (text) => [
      ...byRegex(/(?<![\w-])(?:\d{4}[ -]){3}\d{1,7}(?![\w-])/)(text),
      ...byRegex(/(?<![\w-])(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12}|3(?:0[0-5]|[68]\d)\d{11}|(?:2131|1800|35\d{3})\d{11})(?![\w-])/)(text),
    ].filter((m) => luhn(m.value)),
    description: 'payment card number (issuer prefix or grouped, Luhn-valid)',
  },
];

/**
 * ── Soft rules ───────────────────────────────────────────────────────────
 * Profile-dependent, individually reviewable, and switchable off (with a
 * printed warning). These are judgement calls, so the user gets to make them.
 */
const SOFT_RULES: RedactionRule[] = [
  {
    id: 'email',
    profile: both, category: 'pii', hard: false, prefix: 'SUBJ',
    find: byRegex(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/),
    description: 'email address',
  },
  {
    id: 'phone_e164',
    profile: both, category: 'pii', hard: false, prefix: 'PHONE',
    /**
     * Deliberately narrow. The obvious pattern -- any 8-to-14 digit run -- also
     * matches timestamps, byte counts, ids, and half the numbers in a stack
     * trace. Measured on one real Claude Code session it fired 123 times, all
     * of them wrong, which would have replaced ordinary numbers in the user's
     * own transcript with PHONE-XXXXXX. Over-redaction corrupts the corpus as
     * surely as under-redaction leaks it, and unlike a leak it is invisible.
     *
     * So a match needs actual phone shape: an international prefix, or
     * separators, or explicit context.
     */
    find: (text) => [
      // +886 912 345 678 / +1 (415) 555-0132
      ...byRegex(/(?<![\w.+])\+\d{1,3}[-. ]?\(?\d{2,4}\)?[-. ]\d{3,4}[-. ]?\d{3,4}(?![\w.])/)(text),
      /**
       * 0912-345-678 / (02) 2345-6789.
       *
       * The boundary classes exclude `-`, `:`, `/` and `+` on both sides, not
       * just word characters. Without that, this pattern eats the middle of a
       * UUID (`aaaaaaaa-0000-4000-8000-...` -> "0000-4000-8000", 99 hits on one
       * session) and the tail of a timestamp (`...T04:59:08.384200+00:00` ->
       * "08.384200"). A hyphen is a separator inside a phone number and also
       * inside everything else.
       */
      ...byRegex(/(?<![\w.:+/-])(?:\(0\d{1,3}\)|0\d{1,3})[- ]\d{3,4}[- ]?\d{3,4}(?![\w.:/-])/)(text)
        // A dot is not a separator here. Allowing it matches the fractional
        // part of a timestamp ("...:08.384200") and any decimal of the right
        // shape; dotted phone numbers are rare enough that the trade is
        // lopsided. The digit-count check then rejects anything that is not
        // actually phone-length.
        .filter((m) => {
          const digits = m.value.replace(/\D/g, '').length;
          return digits >= 8 && digits <= 11;
        }),
      // labelled: "tel: 29876543", "phone = 555 0132". The keyword needs real
      // boundaries or it fires inside "hotel" and "excellent".
      ...byRegex(/(?<![a-z])(?:tel|phone|mobile|cell|fax)(?![a-z])\s*[:=]?\s*(\+?[\d\s().-]{7,20}\d)/i)(text),
      ...byRegex(/(?:手機|電話)\s*[:=：]?\s*(\+?[\d\s().-]{7,20}\d)/)(text),
    ],
    description: 'phone number',
  },
  {
    id: 'us_ssn',
    profile: both, category: 'pii', hard: false, prefix: 'GOVID',
    find: byRegex(/\b\d{3}-\d{2}-\d{4}\b/),
    description: 'US social security number',
  },
  {
    id: 'tw_national_id',
    profile: both, category: 'pii', hard: false, prefix: 'GOVID',
    find: byRegex(/\b[A-Z][12]\d{8}\b/),
    description: 'Taiwan national ID number',
  },
  {
    id: 'medical_record_number',
    profile: ['medical'], category: 'pii', hard: false, prefix: 'MRN',
    find: byRegex(/\b(?:MRN|mrn|patient[_ ]?id|chart[_ ]?no)\s*[:#=]?\s*([A-Z0-9-]{5,20})\b/),
    description: 'medical record / patient identifier',
  },
  {
    id: 'date_of_birth',
    profile: ['medical'], category: 'pii', hard: false, prefix: 'DOB',
    find: byRegex(/\b(?:dob|date of birth|birth ?date)\s*[:=]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i),
    description: 'date of birth',
  },
  {
    id: 'ip_address',
    profile: both, category: 'pii', hard: false, prefix: 'IP',
    find: (text) =>
      byRegex(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)(text).filter((m) => {
        const parts = m.value.split('.').map(Number);
        if (parts.some((n) => n > 255)) return false;
        // Loopback and RFC1918 addresses carry no personal information and
        // appear constantly in developer logs; redacting them is pure noise.
        const [a, b] = parts as [number, number, number, number];
        if (a === 127 || a === 10 || a === 0) return false;
        if (a === 192 && b === 168) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        return true;
      }),
    description: 'public IP address',
  },
];

function luhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const HARD_RULE_IDS = HARD_RULES.map((r) => r.id);
export const ALL_RULES: RedactionRule[] = [...HARD_RULES, ...SOFT_RULES];

export function rulesFor(profile: 'medical' | 'general', allowSoft = true): RedactionRule[] {
  return ALL_RULES.filter((r) => r.hard || (allowSoft && r.profile.includes(profile)));
}
