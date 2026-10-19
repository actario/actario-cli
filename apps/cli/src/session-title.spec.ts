import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holdsCall, projectRoots, recentSessions, sessionTitle, titleIn } from './core/session-title.ts';

const rec = (o: unknown) => JSON.stringify(o);
const call = (tool: string, body: string) => rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: `mcp__plugin_actario_actario__${tool}`, input: { from: 'x', body } }] } });

function home() {
  const root = mkdtempSync(join(tmpdir(), 'st-'));
  const projects = join(root, '.claude', 'projects');
  mkdirSync(join(projects, 'C--repo'), { recursive: true });
  return { root, projects, file: (name: string, ...ls: string[]) => { const p = join(projects, 'C--repo', `${name}.jsonl`); writeFileSync(p, ls.join('\n') + '\n'); return p; } };
}

describe('the title of the conversation an agent is in', () => {
  it('the person\'s rename wins over the app\'s name, which wins over an old summary', () => {
    expect(titleIn([rec({ type: 'summary', summary: 'old' }), rec({ type: 'ai-title', aiTitle: 'Message 介面左右對齊' })].join('\n'))).toBe('Message 介面左右對齊');
    expect(titleIn([rec({ type: 'ai-title', aiTitle: 'a' }), rec({ type: 'custom-title', customTitle: '我的名字' }), rec({ type: 'ai-title', aiTitle: 'b' })].join('\n'))).toBe('我的名字');
    expect(titleIn('not json\n')).toBeNull();
  });

  it('two sessions open in the same folder: the one that made this exact call', () => {
    const h = home();
    h.file('aaa', rec({ type: 'ai-title', aiTitle: 'Session A' }), call('send_message', 'hello from A'));
    h.file('bbb', rec({ type: 'ai-title', aiTitle: 'Session B' }), call('send_message', 'hello from B'));
    expect(sessionTitle({ tool: 'send_message', body: 'hello from A' }, { roots: [h.projects], env: {} })).toBe('Session A');
    expect(sessionTitle({ tool: 'send_message', body: 'hello from B' }, { roots: [h.projects], env: {} })).toBe('Session B');
    expect(holdsCall(call('reply', 'hello from A'), { tool: 'send_message', body: 'hello from A' })).toBe(false);
  });

  it('no file holds the call: CLAUDE_CODE_SESSION_ID, else nothing', () => {
    const h = home();
    h.file('5f0c1e2a-0000-4000-8000-000000000001', rec({ type: 'ai-title', aiTitle: 'By id' }));
    expect(sessionTitle({ tool: 'reply', body: 'x' }, { roots: [h.projects], env: { CLAUDE_CODE_SESSION_ID: '5f0c1e2a-0000-4000-8000-000000000001' } })).toBe('By id');
    expect(sessionTitle({ tool: 'reply', body: 'x' }, { roots: [h.projects], env: {} })).toBeNull();
    expect(sessionTitle({ tool: 'reply', body: 'x' }, { roots: ['/nowhere'], env: {} })).toBeNull();
  });

  it('only files written to in the last 15 minutes are looked at', () => {
    const h = home();
    const old = h.file('old', rec({ type: 'ai-title', aiTitle: 'Old' }), call('send_message', 'same'));
    const t = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(old, t, t);
    expect(recentSessions([h.projects])).toEqual([]);
    expect(sessionTitle({ tool: 'send_message', body: 'same' }, { roots: [h.projects], env: {} })).toBeNull();
  });

  it('finds Cowork\'s own Claude homes under the desktop app\'s data, and CLAUDE_CONFIG_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'app-'));
    const deep = join(root, 'Roaming', 'Claude', 'local-agent-mode-sessions', 'acct', 'org', 'local_1', '.claude', 'projects');
    mkdirSync(deep, { recursive: true });
    const cfg = join(root, 'cfg', 'projects'); mkdirSync(cfg, { recursive: true });
    const roots = projectRoots({ APPDATA: join(root, 'Roaming'), CLAUDE_CONFIG_DIR: join(root, 'cfg') }, join(root, 'home'), 'win32');
    expect(roots).toEqual([cfg, deep]);
  });
});
