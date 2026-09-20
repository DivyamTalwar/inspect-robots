import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [
    { name: 'review-policy-text', enforce: 'pre', load(id) { if (id.endsWith('.md')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`; } },
    cloudflareTest({ main: './test/entry.ts', miniflare: {
      compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { LEDGER: { className: 'ReviewLedger', useSQLite: true } },
    } }),
  ],
  test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
});
