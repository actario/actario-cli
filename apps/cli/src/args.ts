/**
 * Tiny argument parser, deliberately dependency-free.
 *
 * The CLI is the funnel (plan 14.4) and R17 says execution frequency is the
 * whole game, so `npx actario capture` should not pay for an argument library
 * on every cold start.
 */
export interface Args {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): Args {
  // A leading flag is a flag, not a command: `actario --version` must not be
  // read as "run the command named --version" and rejected as unknown.
  const first = argv[0];
  const hasCommand = first !== undefined && !first.startsWith('-');
  const command = hasCommand ? first : 'help';
  const rest = hasCommand ? argv.slice(1) : argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('-')) { positional.push(a); continue; }
    const [rawKey, inlineValue] = a.replace(/^--?/, '').split('=', 2) as [string, string?];
    const key = rawKey;
    if (inlineValue !== undefined) { flags[key] = inlineValue; continue; }
    const next = rest[i + 1];
    if (next && !next.startsWith('-')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { command, flags, positional };
}

export const flagString = (a: Args, k: string): string | undefined =>
  typeof a.flags[k] === 'string' ? (a.flags[k] as string) : undefined;

export const flagBool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === 'true';

export const flagList = (a: Args, k: string): string[] =>
  (flagString(a, k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
