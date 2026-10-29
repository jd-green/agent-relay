import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Obvious test tokens (32+ chars) for the four roles; never real secrets.
const TOKENS = {
  ORCHESTRATOR_TOKEN: "test-orchestrator-token-0123456789abcdef",
  CREATIVE_DIRECTOR_TOKEN: "test-creative-director-token-0123456789",
  DEVELOPER_TOKEN: "test-developer-token-0123456789abcdefgh",
  HUMAN_TOKEN: "test-human-token-0123456789abcdefghijkl",
};

function project(name: string, bindings: Record<string, string>, include: string[], exclude: string[] = []) {
  return {
    plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings } })],
    test: { name, include, exclude },
  };
}

export default defineConfig({
  test: {
    projects: [
      project("unit", TOKENS, ["test/unit/**/*.test.ts"], ["test/unit/alt/**"]),
      // Alternate vars: several active builds, a renamed human, and two disabled roles
      // (a too-short token and an empty one, which behaves like an unset secret).
      project(
        "unit-alt",
        { ...TOKENS, MAX_ACTIVE_BUILDS: "3", HUMAN_NAME: "Ada", CREATIVE_DIRECTOR_TOKEN: "too-short", DEVELOPER_TOKEN: "" },
        ["test/unit/alt/**/*.test.ts"],
      ),
    ],
  },
});
