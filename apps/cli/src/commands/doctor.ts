import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allAdapters } from '@distill/adapters';
import { actarioDir, doctor, localEnv, readConfig, schemaProbe } from '@distill/capture';
import { ensureSalt } from '@distill/redaction';
import { bold, dim, green, heading, yellow } from '../print.ts';
import { flagBool, flagString, type Args } from '../args.ts';

/**
 * `actario doctor` -- the compatibility feedback channel (6.3 rule 4).
 *
 * This is the only way to find out that a source format changed. The
 * alternative is watching CQS drift downwards over months with no explanation.
 */
export async function doctorCommand(args: Args): Promise<number> {
  const cfg = readConfig();
  const dir = actarioDir();
  const dumpSample = flagBool(args, 'dump-sample');
  const schema = flagBool(args, 'schema');
  const dumpDir = dumpSample ? await mkdtemp(join(tmpdir(), 'actario-sample-')) : undefined;

  if (schema) return schemaCommand(args);

  const reports = await doctor({
    env: localEnv(cfg.extra_paths),
    adapters: await allAdapters(join(dir, 'adapters')),
    profile: cfg.redaction_profile,
    salt: ensureSalt(dir),
    ...(dumpDir ? { dumpSampleDir: dumpDir } : {}),
  });

  process.stdout.write(heading('Source diagnosis'));
  let anyLoose = false;

  for (const r of reports) {
    const mark = r.found ? green('found') : yellow('not found');
    process.stdout.write(`\n  ${bold(`${r.adapter_id}@${r.adapter_version}`)}  ${mark}\n`);
    if (r.note) process.stdout.write(`    ${dim(r.note)}\n`);
    for (const p of r.paths) process.stdout.write(`    path  ${dim(p)}\n`);
    if (r.found) process.stdout.write(`    units ${dim(`~${r.approx_units}`)}\n`);

    for (const s of r.sampled) {
      const owned = s.handled_by != null;
      const level = s.parse_level === 'strict' ? green('strict')
        : owned ? dim('handled elsewhere') : yellow(s.parse_level);
      process.stdout.write(`    sample ${dim(short(s.unit))} -> ${level}`);
      if (s.matched_adapter) process.stdout.write(dim(`  via ${s.matched_adapter}`));
      if (s.handled_by) process.stdout.write(dim(`  by ${s.handled_by}`));
      process.stdout.write('\n');
      if (s.parse_level !== 'strict' && !owned) {
        anyLoose = true;
        process.stdout.write(`      ${dim(`no adapter version matched (tried: ${s.rejected_versions.join(', ') || 'none'})`)}\n`);
      }
      if (s.unrecognised_keys.length > 0 && !owned) {
        process.stdout.write(`      ${dim(`keys not recognised: ${s.unrecognised_keys.slice(0, 12).join(', ')}`)}\n`);
      }
    }
  }

  if (anyLoose) {
    process.stdout.write(
      `\n${yellow('At least one source is no longer parsed strictly.')}\n` +
      `  That usually means the platform changed its format. Nothing is lost --\n` +
      `  those sessions still come through with reduced detail.\n` +
      `  Run ${bold('actario doctor --dump-sample')} and attach the sample to a report.\n`,
    );
  }
  if (dumpDir) {
    process.stdout.write(
      `\n${green('Samples written')} ${dumpDir}\n` +
      `${dim('They went through the same redaction rules as a real capture, including the ones that cannot be switched off. Read one before sending it.')}\n`,
    );
  }
  return 0;
}

const short = (s: string) => (s.length > 56 ? `...${s.slice(-53)}` : s);

/**
 * `actario doctor --schema` -- what shape are these files, actually.
 *
 * The case this answers: a source parses strictly and still yields no tool
 * records. "Unreadable" is then the wrong word -- the fields did not fail to
 * parse, they moved -- and no amount of staring at CQS will say where to.
 *
 * Only structure is printed: key names, record types, tool names, counts.
 * No message text, no parameter values, no file paths. That is deliberate: an
 * output you have to vet before sharing is an output nobody shares.
 */
async function schemaCommand(args: Args): Promise<number> {
  const cfg = readConfig();
  const dir = actarioDir();
  const limit = Number(flagString(args, 'files') ?? 0);

  const reports = await schemaProbe({
    env: localEnv(cfg.extra_paths),
    adapters: await allAdapters(join(dir, 'adapters')),
    maxFiles: Number.isFinite(limit) ? limit : 0,
  });

  if (reports.length === 0) {
    process.stdout.write(`${heading('Structure')}  ${dim('No sources found on this machine.')}\n`);
    return 0;
  }

  const hist = (label: string, m: Record<string, number>, indent = '    ') => {
    const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      process.stdout.write(`${indent}${label.padEnd(26)} ${dim('none')}\n`);
      return;
    }
    process.stdout.write(`${indent}${label}\n`);
    for (const [k, n] of entries.slice(0, 24)) {
      process.stdout.write(`${indent}  ${String(n).padStart(6)}  ${k}\n`);
    }
    if (entries.length > 24) process.stdout.write(`${indent}  ${dim(`... ${entries.length - 24} more`)}\n`);
  };

  for (const r of reports) {
    process.stdout.write(`${heading(`Structure: ${r.adapter}`)}`);
    process.stdout.write(
      `    files ${r.files_scanned}   records ${r.records}` +
      `   malformed lines ${r.malformed_lines}\n` +
      `    files with tool calls ${r.files_with_tool_calls}/${r.files_scanned}` +
      `   with file paths ${r.files_with_file_paths}/${r.files_scanned}\n`,
    );

    // The line that usually explains everything.
    if (r.files_with_tool_calls === 0 && r.records > 0) {
      process.stdout.write(
        `\n    ${yellow('No tool calls found anywhere in these files.')}\n` +
        `    ${dim('Compare content_block_types below against "tool_use". If tool_use is absent')}\n` +
        `    ${dim('but record_types has a tool-ish entry, the format moved them out of the')}\n` +
        `    ${dim('message and the adapter needs to follow.')}\n\n`,
      );
    } else if (r.tool_calls_outside_content > 0) {
      process.stdout.write(
        `\n    ${yellow(`${r.tool_calls_outside_content} tool call(s) found OUTSIDE message.content.`)}\n` +
        `    ${dim('The adapter only reads content blocks, so these are being missed.')}\n\n`,
      );
    }

    for (const a of r.archives) {
      const verdict = !a.has_conversations_json
        ? yellow('no conversations.json inside -- this is not an export archive')
        : a.conversations_parsed === 0
          ? yellow('contains conversations.json but yielded no conversations')
          : dim(`${a.conversations_parsed} conversation(s) read`);
      process.stdout.write(
        `    archive ${a.file}  ${a.entries ?? '?'} entries  ${verdict}\n`,
      );
    }
    if (r.archives.length > 0) process.stdout.write('\n');

    hist('record_types', r.record_types);
    hist('message_shapes', r.message_shapes);
    hist('message_roles', r.message_roles);
    hist('content_block_types', r.content_block_types);
    hist('tool_names', r.tool_names);
    hist('tool_input_keys', r.tool_input_keys);

    if (r.unrecognised_top_level_keys.length > 0) {
      process.stdout.write(
        `    unrecognised top-level keys\n      ${r.unrecognised_top_level_keys.join(', ')}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${dim('Only structure was printed: key names, record types, tool names and counts.')}\n` +
    `${dim('No message text, parameter values or file paths appear above, so this output')}\n` +
    `${dim('is safe to paste into a report as-is.')}\n`,
  );
  return 0;
}
