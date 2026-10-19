/**
 * Emits JSON Schema next to the zod definition so the CLI, the worker and any
 * future non-TypeScript adapter share one contract. The snapshot is committed:
 * CI diffs it, and a change without a version bump is a failure (arch 14).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { zUcfBundle, zUcfRun, UCF_VERSION } from './schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../schema');
mkdirSync(outDir, { recursive: true });

const emit = (name: string, schema: object) => {
  const path = resolve(outDir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
};

emit(`ucf-bundle-v${UCF_VERSION}`, zodToJsonSchema(zUcfBundle, `ucf-bundle-v${UCF_VERSION}`));
emit(`ucf-run-v${UCF_VERSION}`, zodToJsonSchema(zUcfRun, `ucf-run-v${UCF_VERSION}`));
