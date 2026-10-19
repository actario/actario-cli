import type { CaptureAdapter, LocalEnv } from '@distill/adapters';
import { adapterKey, zipEntryCount, zipHasMember } from '@distill/adapters';

/**
 * Structural probe for `actario doctor --schema`.
 *
 * Section 6.3 rule 4 makes doctor the compatibility reporting channel, and the
 * reason it exists is that the alternative is watching CQS drift downward for
 * reasons nobody can name. This is the sharper version of that: when a source
 * parses strictly but yields no tool records, the question is not "is it
 * broken" but "where did the tool records move to", and answering it needs the
 * actual shape of the file.
 *
 * Everything here is counted, nothing is quoted. The output is key *names*,
 * record `type` *values*, tool *names* and integers -- no message text, no
 * parameter values, no paths. That is what makes this output safe to paste
 * into a bug report or hand to someone else without reading it first, which in
 * turn is what makes people actually run it.
 */
export interface SchemaProbeReport {
  adapter: string;
  files_scanned: number;
  records: number;
  malformed_lines: number;
  /** Top-level `type` values, e.g. user / assistant / summary. */
  record_types: Record<string, number>;
  /** Every top-level key, and whether this adapter version knows it. */
  top_level_keys: Record<string, number>;
  unrecognised_top_level_keys: string[];
  /** Where the conversation payload lives, and what shape it is. */
  message_shapes: Record<string, number>;
  message_roles: Record<string, number>;
  /** Content block `type` values -- this is where tool_use should appear. */
  content_block_types: Record<string, number>;
  /** Tool names, if any were found. Names are structure, not content. */
  tool_names: Record<string, number>;
  /** Key names inside a tool call's input, to locate file paths. */
  tool_input_keys: Record<string, number>;
  /** Files that contained at least one tool call, and at least one file path. */
  files_with_tool_calls: number;
  files_with_file_paths: number;
  /** Set when tool calls appear somewhere other than a content block. */
  tool_calls_outside_content: number;
  /**
   * For archive-backed sources: what detect() saw, per file. Explains the
   * otherwise baffling combination of "found, ~1 unit" with "0 runs".
   * Paths are reported as basenames only.
   */
  archives: {
    file: string;
    entries: number | null;
    has_conversations_json: boolean;
    conversations_parsed: number | null;
  }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const bump = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

/** Keys this adapter version claims to understand, for the "unrecognised" list. */
const RECOGNISED = new Set([
  'type', 'message', 'uuid', 'parentUuid', 'timestamp', 'sessionId', 'cwd',
  'version', 'gitBranch', 'isSidechain', 'userType', 'requestId', 'toolUseResult',
  'isMeta', 'summary', 'leafUuid', 'agentId', 'attributionAgent',
  'sourceToolAssistantUUID', 'promptId', 'entrypoint', 'attachment',
]);

export async function schemaProbe(opts: {
  env: LocalEnv;
  adapters: CaptureAdapter[];
  /** 0 = every unit. Default 0: a wrong answer from a sample is worse than slow. */
  maxFiles?: number;
}): Promise<SchemaProbeReport[]> {
  const byId = new Map<string, CaptureAdapter[]>();
  for (const a of opts.adapters) byId.set(a.id, [...(byId.get(a.id) ?? []), a]);

  const out: SchemaProbeReport[] = [];
  for (const [, versions] of byId) {
    const primary = versions[0]!;
    const detected = await primary.detect(opts.env).catch(() => null);
    if (!detected?.found) continue;

    const r: SchemaProbeReport = {
      adapter: adapterKey(primary),
      files_scanned: 0, records: 0, malformed_lines: 0,
      record_types: {}, top_level_keys: {}, unrecognised_top_level_keys: [],
      message_shapes: {}, message_roles: {}, content_block_types: {},
      tool_names: {}, tool_input_keys: {},
      files_with_tool_calls: 0, files_with_file_paths: 0,
      tool_calls_outside_content: 0, archives: [],
    };

    for (const p of detected.paths) {
      if (!p.toLowerCase().endsWith('.zip')) continue;
      r.archives.push({
        file: p.split(/[\\/]/).pop() ?? p,
        entries: await zipEntryCount(p),
        has_conversations_json: await zipHasMember(p, 'conversations.json'),
        // Filled in below from the units this source actually yielded.
        conversations_parsed: null,
      });
    }

    const limit = opts.maxFiles ?? 0;
    for await (const unit of primary.collect({ env: opts.env, paths: detected.paths })) {
      if (limit > 0 && r.files_scanned >= limit) break;
      r.files_scanned += 1;

      let text: string;
      try { text = await unit.read(); } catch { continue; }

      let sawTool = false;
      let sawPath = false;

      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let rec: unknown;
        try { rec = JSON.parse(line); } catch { r.malformed_lines += 1; continue; }
        if (!isObj(rec)) continue;
        r.records += 1;

        bump(r.record_types, typeof rec.type === 'string' ? rec.type : '(no type field)');
        for (const k of Object.keys(rec)) bump(r.top_level_keys, k);

        // A tool call sitting at the top level rather than inside a content
        // block is the single most likely explanation for "parsed strictly,
        // found no tools", so it gets counted separately.
        if (rec.type === 'tool_use' || rec.type === 'tool_result' || 'tool_use' in rec) {
          r.tool_calls_outside_content += 1;
          sawTool = true;
          if (typeof rec.name === 'string') bump(r.tool_names, rec.name);
        }

        const msg = rec.message;
        if (!isObj(msg)) {
          bump(r.message_shapes, msg === undefined ? '(no message field)' : `message: ${typeof msg}`);
          continue;
        }
        if (typeof msg.role === 'string') bump(r.message_roles, msg.role);

        const content = msg.content;
        if (typeof content === 'string') { bump(r.message_shapes, 'message.content: string'); continue; }
        if (!Array.isArray(content)) {
          bump(r.message_shapes, `message.content: ${content === undefined ? 'absent' : typeof content}`);
          continue;
        }
        bump(r.message_shapes, 'message.content: array');

        for (const block of content) {
          if (typeof block === 'string') { bump(r.content_block_types, '(bare string)'); continue; }
          if (!isObj(block)) continue;
          const t = typeof block.type === 'string' ? block.type : '(no type)';
          bump(r.content_block_types, t);
          if (t !== 'tool_use') continue;
          sawTool = true;
          if (typeof block.name === 'string') bump(r.tool_names, block.name);
          if (isObj(block.input)) {
            for (const k of Object.keys(block.input)) {
              bump(r.tool_input_keys, k);
              if (/^(file_?path|path|notebook_?path)$/i.test(k)) sawPath = true;
            }
          }
        }
      }

      if (sawTool) r.files_with_tool_calls += 1;
      if (sawPath) r.files_with_file_paths += 1;
    }

    for (const a of r.archives) a.conversations_parsed = r.files_scanned;

    r.unrecognised_top_level_keys = Object.keys(r.top_level_keys)
      .filter((k) => !RECOGNISED.has(k)).sort();
    out.push(r);
  }
  return out;
}
