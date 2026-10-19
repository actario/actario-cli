import { flagBool, flagList, flagString, type Args } from '../args.ts';
import { bold, dim, formatRemediation, formatReport, green, heading, red, yellow } from '../print.ts';
import { captureFlow } from '../core/capture.ts';

/**
 * `actario capture` -- the daily path. One command, no interaction, exit code
 * carries the verdict (5.2). Guidance appears in exactly two situations:
 * first-time setup (`actario init`) and a problem worth acting on.
 *
 * The sequence itself lives in core/capture.ts and is shared with the MCP
 * tool of the same name; this file only decides what to print and which exit
 * code each ending maps to.
 */
export async function captureCommand(args: Args): Promise<number> {
  const noRedact = flagBool(args, 'no-redact');
  if (noRedact) {
    // Loud on purpose. The flag cannot reach the hard rules (C6), and the user
    // should know exactly which half they just switched off.
    process.stderr.write(
      `${yellow('--no-redact is set.')} Personal-data rules are OFF for this run.\n` +
      `${dim('Credential and key rules stay ON; they cannot be disabled.')}\n\n`,
    );
  }

  const sources = flagList(args, 'sources');
  const r = await captureFlow({
    dryRun: flagBool(args, 'dry-run'),
    noRedact,
    noDiffs: flagBool(args, 'no-diffs'),
    ...(sources.length > 0 ? { sources } : {}),
    ...(flagString(args, 'since') ? { since: flagString(args, 'since') } : {}),
    ...(flagString(args, 'api-url') ? { apiUrl: flagString(args, 'api-url') } : {}),
  });

  // ── nothing new is not a failure ──
  //
  // Every session on this machine was captured already. Without this case
  // the score is computed over zero runs, rejects, and sends the user to
  // `actario doctor` -- where they find nothing wrong, because nothing is.
  // R17 makes it worth its own branch: capture runs from cron, and a command
  // that reports failure on every quiet day teaches its owner to ignore it.
  if (r.kind === 'up_to_date') {
    process.stdout.write(
      `${heading('Up to date')}` +
      `  ${r.skippedDuplicates} run(s) already captured from this machine; nothing new since the last run.\n` +
      `${dim('  Sources checked: ')}${dim(r.adapters.join(', ') || 'none')}\n\n` +
      `  Analyse a batch that is already here: ${bold('actario analyze')}\n` +
      `  ${dim('Re-read everything (the server deduplicates, so it costs nothing): actario reset-state')}\n`,
    );
    return 0;
  }

  const { outcome } = r;
  process.stdout.write(`${formatReport(outcome.report, outcome.verdict)}\n`);
  if (outcome.skippedDuplicates > 0) {
    process.stdout.write(dim(`  ${outcome.skippedDuplicates} run(s) already uploaded previously, skipped.\n`));
  }

  if (r.kind === 'rejected') {
    process.stdout.write(`${formatRemediation(outcome.remediation)}\n\n`);
    process.stderr.write(`${red('Not uploaded.')} Capture quality is below the threshold.\n`);
    return 2;
  }
  if (outcome.remediation.length > 0) {
    process.stdout.write(`${formatRemediation(outcome.remediation)}\n`);
  }

  switch (r.kind) {
    case 'dry_run':
      process.stdout.write(`\n${dim('--dry-run: nothing was uploaded and no local state changed.')}\n`);
      return 0;
    case 'not_linked':
      process.stdout.write(
        `\n${yellow('Bundle built but not uploaded:')} this machine is not linked yet.\n` +
        `  bundle: ${r.bundleDir}\n` +
        `  run ${bold('actario init')} to set the API URL, token and source id.\n`,
      );
      return 3;
    case 'upload_failed':
      process.stderr.write(`\n${red('Upload failed:')} ${r.error.message}\n`);
      if (r.error.code === 'manifest_mismatch') {
        process.stderr.write(`${dim('Some parts did not arrive. Re-running capture re-sends only the missing files.')}\n`);
      }
      process.stderr.write(`${dim(`Local bundle kept at ${r.bundleDir}; nothing was marked as captured.`)}\n`);
      return 1;
    case 'uploaded':
      if (r.keepError) process.stderr.write(`${yellow('Could not keep the bundle locally:')} ${r.keepError}\n`);
      process.stdout.write(
        `\n${green('Uploaded.')} ${r.files} file(s), upload ${r.uploadId}` +
        `${r.resumed ? dim(' (resumed an earlier attempt)') : ''}\n` +
        `${dim(`Track it: actario status ${r.uploadId}`)}\n` +
        (r.keptAt ? `${dim(`Bundle kept at ${r.keptAt}`)}\n` : '') +
        `\nNext: ${bold('actario analyze')} -- the analysis runs here, on your own subscription, and lands as pending.\n`,
      );
      return 0;
  }
}
