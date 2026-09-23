import { describe, expect, it } from 'vitest';
import { RedactionEngine } from '@distill/redaction';
import { zDaf } from '@distill/daf';
import { redactDafText } from './core/analyze.ts';

/**
 * Design 0002: the analysis text a local agent wrote crosses the same hard
 * redaction rules as the record before it leaves the machine (C6).
 */
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const daf = () => zDaf.parse({
  daf_version: '0.2', bundle_id: '00000000-0000-4000-8000-000000000001',
  analyzer: { kind: 'agent_session', prompt_version: 'client-notes@2026-10-04', produced_at: '2026-10-04T10:00:00+08:00' },
  segments: [{ run_hash: 'h'.repeat(64), start_turn_idx: 0, end_turn_idx: 1, topic: '設定', summary: `換掉 ANTHROPIC_API_KEY=${KEY}` }],
  pages: [{
    run_hash: 'h'.repeat(64), title: '設定筆記', summary: null,
    sections: [{ heading: '步驟', start_turn_idx: 0, end_turn_idx: 1, body: `\`\`\`\nexport ANTHROPIC_API_KEY=${KEY}\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |` }],
  }],
});

describe('redactDafText', () => {
  it('replaces a credential in segment and page text, counts it, and leaves the Markdown intact', () => {
    const d = daf();
    const engine = new RedactionEngine({ profile: 'general', salt: 'test-salt' });
    const r = redactDafText(d, engine);
    expect(r.hits).toBe(2);
    expect(JSON.stringify(d)).not.toContain('sk-ant-api03');
    expect(d.pages[0]!.sections[0]!.body).toContain('| a | b |');
    expect(d.pages[0]!.title).toBe('設定筆記');
  });

  it('is a no-op on clean text', () => {
    const d = zDaf.parse({ ...daf(), segments: [], pages: [{ ...daf().pages[0]!, sections: [{ heading: 'h', start_turn_idx: 0, end_turn_idx: 0, body: 'plain' }] }] });
    expect(redactDafText(d, new RedactionEngine({ profile: 'general', salt: 's' })).hits).toBe(0);
    expect(d.pages[0]!.sections[0]!.body).toBe('plain');
  });
});
