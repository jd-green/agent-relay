import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config";
import { TOKENS, api, call, createBuild, expectError, fetchWorker, mcp, send, useCleanState, type Json } from "../helpers";

// This project runs with MAX_ACTIVE_BUILDS=3, HUMAN_NAME=Ada, a too-short creative
// director token and an empty developer token (see vitest.config.ts).
useCleanState();

describe("disabled roles", () => {
  it("never authenticate a token shorter than 32 characters", async () => {
    expect(TOKENS["creative-director"]).toBe("too-short");
    const response = await fetchWorker("/api/me", { headers: { authorization: "Bearer too-short" } });
    expect(response.status).toBe(401);
    const viaMcp = await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" }, "/mcp/too-short");
    expect(viaMcp.status).toBe(401);
  });

  it("never authenticate when the token is unset", async () => {
    expect(TOKENS.developer).toBe("");
    const response = await fetchWorker("/api/me", { headers: { authorization: "Bearer " } });
    expect(response.status).toBe(401);
    const viaMcp = await mcp("", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(viaMcp.status).toBe(401);
  });

  it("are reported as disabled in the role directory", async () => {
    const me = await call("orchestrator", "whoami");
    expect(me.roles.map((role: Json) => [role.id, role.enabled])).toEqual([
      ["orchestrator", true],
      ["creative-director", false],
      ["developer", false],
      ["human", true],
    ]);
  });
});

describe("HUMAN_NAME", () => {
  it("names the human role and adds an alias", async () => {
    expect(loadConfig(env).humanName).toBe("Ada");
    const me = await call("human", "whoami");
    expect(me.display_name).toBe("Ada");
    expect(me.roles.find((role: Json) => role.id === "human").aliases).toEqual(["james", "ada"]);
    const build = await createBuild();
    const { message } = await send("orchestrator", { build_id: build.build_id, to_role: "Ada", type: "question", body: "Colours?" });
    expect(message.to).toBe("human");
  });
});

describe("MAX_ACTIVE_BUILDS=3", () => {
  it("allows three active builds and refuses a fourth", async () => {
    for (let i = 1; i <= 3; i += 1) await createBuild({ title: `Build ${i}` });
    await expectError("human", "build_create", { title: "Build 4", brief: "x" }, "conflict");
    const { builds } = await call("orchestrator", "build_list");
    expect(builds).toHaveLength(3);
  });
});

describe("inbox across builds", () => {
  it("aggregates every active build and ignores `since`", async () => {
    const first = await createBuild({ title: "First", brief: "Brief one" });
    const second = await createBuild({ title: "Second", brief: "Brief two" });
    const third = await createBuild({ title: "Third", brief: "Brief three" });
    await call("human", "build_control", { build_id: third.build_id, action: "cancel" });
    await send("human", { build_id: second.build_id, to_role: "orchestrator", type: "status", body: "Second follow-up" });

    const inbox = await call("orchestrator", "inbox", { since: 5, session_ref: "orchestrator-main" });
    expect(inbox.builds.map((entry: Json) => entry.build_id)).toEqual([first.build_id, second.build_id]);
    expect(inbox.builds.map((entry: Json) => entry.messages.map((m: Json) => m.body))).toEqual([
      ["Brief one"],
      ["Brief two", "Second follow-up"],
    ]);
    expect(inbox.builds.map((entry: Json) => entry.thread_key)).toEqual([
      `${first.build_id}/orchestrator`,
      `${second.build_id}/orchestrator`,
    ]);

    const again = await call("orchestrator", "inbox", {});
    expect(again.builds.flatMap((entry: Json) => entry.messages)).toEqual([]);
    const ledger = await call("human", "ledger_get", { build_id: second.build_id });
    expect(ledger.threads.find((t: Json) => t.role === "orchestrator").session_ref).toBe("orchestrator-main");
  });

  it("is also served by GET /api/inbox", async () => {
    await createBuild({ title: "First" });
    await createBuild({ title: "Second" });
    const { body } = await api("orchestrator", "GET", "/api/inbox?peek=1");
    expect(body.result.builds).toHaveLength(2);
  });
});
