#!/usr/bin/env node
// Dev entry point. `npm run cli -- capture` uses this via tsx; the published
// package ships a bundled build (arch v1.5 unresolved #5).
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(resolve(here, '../src/index.ts')).href;
const { main } = await import(entry);
await main(process.argv.slice(2));
