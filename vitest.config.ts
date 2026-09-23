import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/**/*.spec.ts', 'apps/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@distill/adapters': r('./packages/adapters/src/index.ts'),
      '@distill/capture': r('./packages/capture/src/index.ts'),
      '@distill/daf': r('./packages/daf/src/index.ts'),
      '@distill/export': r('./packages/export/src/index.ts'),
      '@distill/redaction': r('./packages/redaction/src/index.ts'),
      '@distill/shared': r('./packages/shared/src/index.ts'),
      '@distill/ucf': r('./packages/ucf/src/index.ts'),
    },
  },
});
