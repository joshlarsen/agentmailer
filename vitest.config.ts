import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { OWNER_TOKEN: "test-owner" } },
    }),
  ],
});
