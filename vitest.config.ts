import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { OWNER_TOKEN: 'test-owner' } },
    }),
  ],
})
