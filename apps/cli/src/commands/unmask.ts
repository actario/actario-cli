import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { actarioDir } from '@distill/capture';
import {
  UNMASK_MARKER_NAME, UNMASK_MARKER_TEXT, readZip, reverseMap, unmaskMembers,
  type Member, type RedactionMapFile,
} from '@distill/export';
import { readEncrypted } from '@distill/redaction';
import { bold, dim, green, heading, red, yellow } from '../print.ts';
import { flagString, type Args } from '../args.ts';

/**
 * `actario unmask <export.zip | dir> [--out DIR]` -- reverse pseudonyms
 * locally (design unit 0001 §4.4).
 *
 * This is the "unmask option" of the export, and it is a separate command on
 * purpose. The web download hands back exactly what the server holds, and the
 * server holds pseudonyms only: the salt and the original → pseudonym map have
 * never left ~/.actario. So there is no server-side flag to add; reversal can
 * only happen here, on an archive the user already has, when they ask for it.
 *
 * The output directory gets a marker file. The adapters never scan an
 * arbitrary directory, so an unmasked export cannot be captured by accident
 * unless someone moves it into ~/.actario/inbox -- and this command refuses
 * to write anywhere under ~/.actario for that reason.
 */
export async function unmaskCommand(args: Args): Promise<number> {
  const input = args.positional[0];
  if (!input) {
    process.stderr.write(`${red('Usage:')} actario unmask <export.zip | dir> [--out DIR]\n`);
    return 1;
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    process.stderr.write(`${red('Not found:')} ${inputPath}\n`);
    return 1;
  }

  const home = actarioDir();
  const saltPath = join(home, 'salt');
  const mapPath = join(home, 'redaction_map.json.enc');
  if (!existsSync(saltPath) || !existsSync(mapPath)) {
    process.stderr.write(
      `${red('No redaction map on this machine.')} ${dim(`(${mapPath})`)}\n` +
      `Pseudonyms can only be reversed on the machine that captured them; the map never leaves it.\n`,
    );
    return 3;
  }
  const salt = readFileSync(saltPath, 'utf8').trim();
  const map = readEncrypted<RedactionMapFile>(mapPath, salt);
  if (!map || map.version !== 1) {
    process.stderr.write(`${red('Could not read the redaction map.')} Wrong salt, or the file is damaged.\n`);
    return 1;
  }
  const reverse = reverseMap(map);

  const isDir = statSync(inputPath).isDirectory();
  const outDir = resolve(flagString(args, 'out') ?? defaultOut(inputPath, isDir));
  const homeAbs = resolve(home);
  if (outDir === homeAbs || outDir.startsWith(homeAbs + sep)) {
    process.stderr.write(`${red('Refusing to write under')} ${homeAbs}: that is the capture inbox.\n`);
    return 1;
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    process.stderr.write(`${red('Output directory is not empty:')} ${outDir}\n${dim('Pass --out to choose another.')}\n`);
    return 1;
  }

  const members: Member[] = isDir ? readDir(inputPath) : readZip(readFileSync(inputPath)).map((m) => ({ name: m.name, data: m.data() }));
  const { members: out, report } = unmaskMembers(members, reverse);

  for (const m of out) {
    const target = join(outDir, ...m.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, m.data);
  }
  writeFileSync(join(outDir, UNMASK_MARKER_NAME), UNMASK_MARKER_TEXT, { mode: 0o600 });

  const total = Object.values(report.replaced).reduce((a, b) => a + b, 0);
  process.stdout.write(heading(`Unmasked ${out.length} file(s) → ${outDir}`));
  if (total === 0) process.stdout.write(`  ${dim('No pseudonyms from this machine were found.')}\n`);
  for (const [prefix, n] of Object.entries(report.replaced).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${green(String(n).padStart(6))}  ${prefix}\n`);
  }
  if (report.unknown > 0) {
    // Honest about the gap rather than guessing: these were made under a
    // different salt (another machine), and nothing here can reverse them.
    process.stdout.write(
      `  ${yellow(String(report.unknown).padStart(6))}  ${yellow('not in this machine\'s map')} ` +
      `${dim(`(e.g. ${report.unknown_samples.slice(0, 3).join(', ')})`)}\n`,
    );
  }
  process.stdout.write(`\n  ${bold('Keep this directory out of any captured path.')} ${dim(`Marker: ${UNMASK_MARKER_NAME}`)}\n`);
  return 0;
}

function defaultOut(inputPath: string, isDir: boolean): string {
  const base = basename(inputPath);
  const stem = !isDir && base.toLowerCase().endsWith('.zip') ? base.slice(0, -4) : base;
  return join(dirname(inputPath), `${stem}.unmasked`);
}

function readDir(root: string): Member[] {
  const out: Member[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ name: relative(root, p).split(sep).join('/'), data: readFileSync(p) });
    }
  };
  walk(root);
  return out;
}
