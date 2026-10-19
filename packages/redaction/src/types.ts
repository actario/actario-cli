export type RedactionProfile = 'medical' | 'general';
export type RedactionCategory = 'secret' | 'pii' | 'custom';

export interface Match {
  start: number;
  end: number;
  value: string;
}

export interface RedactionRule {
  id: string;
  /** Which profiles the rule participates in. Hard rules ignore this. */
  profile: RedactionProfile[];
  category: RedactionCategory;
  /**
   * C6: hard rules cannot be turned off. Not by profile, not by config, not by
   * --no-redact. The cost of leaking a credential is asymmetric, so the switch
   * that would leak it does not exist.
   */
  hard: boolean;
  /** Short pseudonym prefix, e.g. SUBJ / KEY / EMAIL. */
  prefix: string;
  find(text: string): Match[];
  /** Human explanation used by `actario doctor` and the CLI warning banner. */
  description: string;
}

export interface RedactionHit {
  ruleId: string;
  category: RedactionCategory;
  hard: boolean;
  pseudonym: string;
  /** Kept in memory only, written to the local encrypted map, never uploaded. */
  original: string;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}
