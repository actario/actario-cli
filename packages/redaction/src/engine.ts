import { pseudonymFor } from './pseudonym.ts';
import { rulesFor } from './rules.ts';
import type {
  Match, RedactionHit, RedactionProfile, RedactionResult, RedactionRule,
} from './types.ts';

export interface EngineOptions {
  profile: RedactionProfile;
  salt: string;
  /**
   * `--no-redact`. Disables soft rules only; hard rules are unreachable from
   * here by construction (C6). The CLI prints a loud banner when this is set.
   */
  allowSoft?: boolean;
  /** Individually disabled soft rule ids from ~/.actario/config.json. */
  disabledRuleIds?: string[];
}

export class RedactionEngine {
  private readonly rules: RedactionRule[];
  private readonly salt: string;
  /** original -> pseudonym. Stays local, written encrypted (13.1). */
  readonly map = new Map<string, string>();
  readonly counts = new Map<string, number>();

  constructor(opts: EngineOptions) {
    const disabled = new Set(opts.disabledRuleIds ?? []);
    this.rules = rulesFor(opts.profile, opts.allowSoft !== false)
      // A disabled hard rule is not a disabled rule.
      .filter((r) => r.hard || !disabled.has(r.id));
    this.salt = opts.salt;
  }

  get activeRuleIds(): string[] {
    return this.rules.map((r) => r.id);
  }

  redactText(text: string): RedactionResult {
    if (!text) return { text, hits: [] };

    // Collect every rule's matches, then resolve overlaps before rewriting:
    // "sk-ant-..." matches both the Anthropic rule and the generic assignment
    // rule, and replacing twice would corrupt the output.
    const found: (Match & { rule: RedactionRule })[] = [];
    for (const rule of this.rules) {
      let matches: Match[];
      try {
        matches = rule.find(text);
      } catch {
        continue; // a broken rule must not take down a capture
      }
      for (const m of matches) if (m.end > m.start) found.push({ ...m, rule });
    }
    if (found.length === 0) return { text, hits: [] };

    // Longest match wins; hard rules win ties. Then drop anything overlapping
    // an already-accepted span.
    found.sort((a, b) => {
      const len = (b.end - b.start) - (a.end - a.start);
      if (len !== 0) return len;
      if (a.rule.hard !== b.rule.hard) return a.rule.hard ? -1 : 1;
      return a.start - b.start;
    });

    const accepted: (Match & { rule: RedactionRule })[] = [];
    for (const cand of found) {
      if (accepted.some((a) => cand.start < a.end && cand.end > a.start)) continue;
      accepted.push(cand);
    }
    accepted.sort((a, b) => a.start - b.start);

    const hits: RedactionHit[] = [];
    let out = '';
    let cursor = 0;
    for (const a of accepted) {
      const pseudonym = pseudonymFor(a.rule, a.value, this.salt);
      out += text.slice(cursor, a.start) + pseudonym;
      cursor = a.end;
      this.map.set(a.value, pseudonym);
      this.counts.set(a.rule.id, (this.counts.get(a.rule.id) ?? 0) + 1);
      hits.push({
        ruleId: a.rule.id,
        category: a.rule.category,
        hard: a.rule.hard,
        pseudonym,
        original: a.value,
      });
    }
    out += text.slice(cursor);
    return { text: out, hits };
  }

  /** Walks tool_call params, artifact summaries, titles -- anything nested. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redactText(value).text as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.redactDeep(v);
      }
      return out as unknown as T;
    }
    return value;
  }

  summary(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** The local redaction map. Written encrypted; never part of a bundle. */
  exportMap(): { version: 1; entries: { original: string; pseudonym: string }[] } {
    return {
      version: 1,
      entries: [...this.map.entries()].map(([original, pseudonym]) => ({ original, pseudonym })),
    };
  }
}
