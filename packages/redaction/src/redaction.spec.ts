import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RedactionEngine } from './engine.ts';
import { HARD_RULE_IDS, rulesFor } from './rules.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../__fixtures__/must-catch');
const SALT = 'test-salt-not-a-real-one';

function loadFixture(file: string) {
  // `{{}}` splits a token on disk so secret scanners do not match the file;
  // see __fixtures__/must-catch/README.md. The engine sees the joined value.
  const raw = readFileSync(join(FIXTURES, file), 'utf8').replaceAll('{{}}', '');
  const [header, ...rest] = raw.split('\n---\n');
  const secrets = (header ?? '')
    .split('\n')
    .filter((l) => l.startsWith('SECRET:'))
    .map((l) => l.slice('SECRET:'.length));
  return { secrets, body: rest.join('\n---\n') };
}

const fixtureFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt'));

describe('hard redaction rules (C6)', () => {
  it('has fixtures to check', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const file of fixtureFiles) {
    const { secrets, body } = loadFixture(file);

    it(`${file}: every marked secret is removed (medical profile)`, () => {
      const engine = new RedactionEngine({ profile: 'medical', salt: SALT });
      const { text } = engine.redactText(body);
      for (const s of secrets) expect(text, `leaked from ${file}`).not.toContain(s);
    });

    it(`${file}: --no-redact does not reach hard rules`, () => {
      // The flag disables soft rules only. If this test ever passes a leak
      // through, the flag has grown a reach it must not have.
      const engine = new RedactionEngine({ profile: 'general', salt: SALT, allowSoft: false });
      const { text } = engine.redactText(body);
      for (const s of secrets) expect(text, `leaked from ${file} with --no-redact`).not.toContain(s);
    });

    it(`${file}: disabling every rule by id still cannot disable a hard rule`, () => {
      const engine = new RedactionEngine({
        profile: 'medical',
        salt: SALT,
        disabledRuleIds: [...HARD_RULE_IDS, 'email', 'phone_e164'],
      });
      const { text } = engine.redactText(body);
      for (const s of secrets) expect(text, `leaked from ${file} via config`).not.toContain(s);
    });
  }
});

describe('pseudonyms', () => {
  it('are stable across captures, so entity linking survives time (6.5)', () => {
    const a = new RedactionEngine({ profile: 'general', salt: SALT });
    const b = new RedactionEngine({ profile: 'general', salt: SALT });
    const first = a.redactText('ping jacky@example.com about the schema');
    const later = b.redactText('jacky@example.com replied three months later');
    const token = first.hits[0]?.pseudonym;
    expect(token).toBeTruthy();
    expect(later.text).toContain(token!);
  });

  it('differ per machine, so the server cannot reverse them', () => {
    const a = new RedactionEngine({ profile: 'general', salt: 'salt-a' });
    const b = new RedactionEngine({ profile: 'general', salt: 'salt-b' });
    expect(a.redactText('jacky@example.com').text)
      .not.toEqual(b.redactText('jacky@example.com').text);
  });

  it('are readable, not [REDACTED]', () => {
    const e = new RedactionEngine({ profile: 'general', salt: SALT });
    expect(e.redactText('mail jacky@example.com').text).toMatch(/SUBJ-[0-9A-F]{6}/);
  });
});

describe('overlapping matches', () => {
  it('replaces a secret once, not twice', () => {
    // sk-ant-... matches both the Anthropic rule and generic_secret_assignment.
    const e = new RedactionEngine({ profile: 'general', salt: SALT });
    const { text, hits } = e.redactText('ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAA');
    expect(text).not.toContain('sk-ant-api03');
    expect(text.match(/KEY-[0-9A-F]{6}/g)?.length).toBe(1);
    expect(hits).toHaveLength(1);
  });
});

describe('soft rules', () => {
  it('are profile-scoped: MRN only applies to the medical profile', () => {
    const general = rulesFor('general').map((r) => r.id);
    const medical = rulesFor('medical').map((r) => r.id);
    expect(medical).toContain('medical_record_number');
    expect(general).not.toContain('medical_record_number');
  });

  it('leave private and loopback addresses alone (noise, not personal data)', () => {
    const e = new RedactionEngine({ profile: 'general', salt: SALT });
    const { text } = e.redactText('server on 192.168.1.20 and 127.0.0.1, prod at 203.0.113.9');
    expect(text).toContain('192.168.1.20');
    expect(text).toContain('127.0.0.1');
    expect(text).not.toContain('203.0.113.9');
  });
});

describe('redactDeep', () => {
  it('reaches tool_call params and nested structures', () => {
    const e = new RedactionEngine({ profile: 'general', salt: SALT });
    const out = e.redactDeep({
      name: 'Bash',
      params: { command: 'psql postgres://u:p4ssword-here@db.acme.io/prod -c "select 1"' },
      nested: [{ note: 'ask jacky@example.com' }],
    });
    expect(JSON.stringify(out)).not.toContain('p4ssword-here');
    expect(JSON.stringify(out)).not.toContain('jacky@example.com');
  });
});

describe('precision: ordinary numbers must survive redaction', () => {
  /**
   * Measured regression. On one real Claude Code session the first versions of
   * these two rules fired 139 times, every one of them wrong, replacing
   * ordinary numbers in the user's own transcript with PHONE-XXXXXX and
   * CARD-XXXXXX. Over-redaction corrupts the record as thoroughly as a leak,
   * and unlike a leak nobody notices.
   */
  const e = () => new RedactionEngine({ profile: 'medical', salt: SALT });

  const shouldSurvive = [
    'the build took 1788412701961 ms',
    'commit 4111111111111112 is not a card',
    'port 54322, pid 1043829, 20260903000500_derived.sql',
    'processed 1204 vectors in 41s, index rebuilt at 09:12:04',
    'sha 0d1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b',
    'HTTP 429 after 5 retries, backoff 400 800 1600 3200',
    'lines 218 to 12000 of clean_v3.py',
  ];

  for (const text of shouldSurvive) {
    it(`leaves alone: ${text.slice(0, 42)}`, () => {
      expect(e().redactText(text).text).toBe(text);
    });
  }

  const shouldStillCatch: [string, string][] = [
    ['call me on +886 912 345 678 tomorrow', '+886 912 345 678'],
    ['office is (02) 2345-6789', '(02) 2345-6789'],
    ['tel: 0912-345-678', '0912-345-678'],
    ['card 4111 1111 1111 1111 declined', '4111 1111 1111 1111'],
    ['charged 4111111111111111 twice', '4111111111111111'],
  ];

  for (const [text, secret] of shouldStillCatch) {
    it(`still catches: ${secret}`, () => {
      expect(e().redactText(text).text).not.toContain(secret);
    });
  }
});

describe('generic_secret_assignment tells a secret from code that refers to one (v1.2 scope)', () => {
  const engine = () => new RedactionEngine({ profile: 'general', salt: 's', allowSoft: false });

  it('leaves identifier references alone', () => {
    const code = [
      "const token = process.env.DISTILL_TOKEN;",
      "api_key: cfg.anthropic.apiKey,",
      "secret = SUPABASE_SERVICE_ROLE_KEY",
      "password: settings.database.password",
    ].join('\n');
    const r = engine().redactText(code);
    expect(r.hits).toEqual([]);
    expect(r.text).toBe(code);
  });

  it('still catches real values, in every shape a value comes in', () => {
    for (const line of [
      'password = hunter2pass2024',
      'api_key: "AIza0123456789abcdefghij"',
      "token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'",
      'client_secret=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==',
    ]) {
      const r = engine().redactText(line);
      expect(r.hits.map((h) => h.ruleId), line).toContain('generic_secret_assignment');
    }
  });
});
