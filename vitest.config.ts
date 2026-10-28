import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ORCHESTRATOR_TOKEN: "test-orchestrator-token-0123456789abcdef",
          CREATIVE_DIRECTOR_TOKEN: "test-creative-director-token-0123456789",
          DEVELOPER_TOKEN: "test-developer-token-0123456789abcdefgh",
          HUMAN_TOKEN: "test-human-token-0123456789abcdefghijkl",
        },
      },
    }),
  ],
  test: { include: ["test/unit/**/*.test.ts"] },
});
