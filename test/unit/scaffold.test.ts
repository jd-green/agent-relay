import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
it("serves text modules", async () => {
  const r = await exports.default.fetch("http://x/");
  expect(await r.text()).toContain("Agent Relay");
});
