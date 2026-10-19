/**
 * Bundle this tree the way the published package is bundled: the workspace
 * packages inlined, the published dependencies left external. Run it to compare
 * against what npm serves for @actario/cli.
 */
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [join(root, 'apps/cli/src/index.ts')],
  outfile: join(root, 'dist', 'actario.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ["@modelcontextprotocol/sdk","pptxgenjs","zod"],
  logOverride: { 'unsupported-dynamic-import': 'silent' },
  metafile: true,
});
const o = Object.values(result.metafile.outputs)[0];
console.log('dist/actario.js, ' + (o.bytes / 1024).toFixed(0) + ' kB');
