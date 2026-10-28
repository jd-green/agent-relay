import { describe, expect, it } from "vitest";
import { authenticate } from "../../src/auth";
import { env } from "cloudflare:workers";
import { TOKENS, api, call, callRaw, createBuild, fetchWorker, mcp, useCleanState, type Role } from "./helpers";

useCleanState();

const ROLES: Role[] = ["orchestrator", "creative-director", "developer", "human"];

describe("auth", () => {
  it("maps each Bearer token to its role", async () => {
    for (const role of ROLES) {
      const { status, body } = await api(role, "GET", "/api/me");
      expect(status).toBe(200);
      expect(body.result.role).toBe(role);
    }
  });

  it("rejects a missing or unknown token with 401", async () => {
    const missing = await api(null, "GET", "/api/me");
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("unauthorized");

    const unknown = await fetchWorker("/api/me", { headers: { authorization: `Bearer ${"x".repeat(40)}` } });
    expect(unknown.status).toBe(401);

    const wrongScheme = await fetchWorker("/api/me", { headers: { authorization: `Basic ${TOKENS.human}` } });
    expect(wrongScheme.status).toBe(401);
  });

  it("accepts the token in the /mcp/<token> path", async () => {
    const response = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }, `/mcp/${TOKENS.developer}`);
    expect(response.status).toBe(200);
    const body = await response.json<{ result: { structuredContent: { role: string } } }>();
    expect(body.result.structuredContent.role).toBe("developer");
  });

  it("falls back to the path token when the header token is unknown", async () => {
    const response = await fetchWorker(`/mcp/${TOKENS.human}`, {
      method: "POST",
      headers: { authorization: `Bearer ${"z".repeat(40)}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
    });
    const body = await response.json<{ result: { structuredContent: { role: string } } }>();
    expect(body.result.structuredContent.role).toBe("human");
  });

  it("treats a malformed path token as missing", async () => {
    const response = await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" }, "/mcp/%E0%A4%A");
    expect(response.status).toBe(401);
  });

  it("rejects an unknown /mcp/<token> path with a JSON-RPC 401", async () => {
    const response = await mcp(null, { jsonrpc: "2.0", id: 1, method: "ping" }, `/mcp/${"y".repeat(40)}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const body = await response.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32001);
  });

  it("does not accept path tokens on the JSON API", async () => {
    const response = await fetchWorker(`/api/me/${TOKENS.human}`);
    expect(response.status).toBe(401);
  });

  it("authenticates in constant-time style without leaking a match for prefixes", async () => {
    expect(await authenticate(env, TOKENS.human)).toBe("human");
    expect(await authenticate(env, TOKENS.human.slice(0, -1))).toBeNull();
    expect(await authenticate(env, `${TOKENS.human}x`)).toBeNull();
    expect(await authenticate(env, "")).toBeNull();
    expect(await authenticate(env, null)).toBeNull();
  });
});

describe("sender identity", () => {
  it("always comes from the token", async () => {
    const build = await createBuild();
    const { message } = await call("orchestrator", "send", {
      build_id: build.build_id,
      to_role: "developer",
      type: "question",
      body: "Which framework?",
      from: "orchestrator",
    });
    expect(message.from).toBe("orchestrator");
  });

  it("rejects input that names another sender", async () => {
    const build = await createBuild();
    for (const field of ["from", "sender", "from_role", "on_behalf_of", "role"]) {
      const { status, body } = await callRaw("developer", "send", {
        build_id: build.build_id,
        to_role: "orchestrator",
        type: "status",
        body: "I am James",
        [field]: "human",
      });
      expect(status).toBe(403);
      expect(body.error.code).toBe("forbidden");
      expect(body.error.message).toContain(field);
    }
    const inbox = await call("orchestrator", "inbox", { build_id: build.build_id });
    expect(inbox.builds[0].messages.map((m: { from: string }) => m.from)).toEqual(["human"]);
  });

  it("cannot send as the relay pseudo-role or to it", async () => {
    const build = await createBuild();
    const asRelay = await callRaw("developer", "send", {
      build_id: build.build_id,
      to_role: "orchestrator",
      type: "status",
      body: "system notice",
      from: "relay",
    });
    expect(asRelay.body.error.code).toBe("forbidden");
    const toRelay = await callRaw("developer", "send", {
      build_id: build.build_id,
      to_role: "relay",
      type: "status",
      body: "hello relay",
    });
    expect(toRelay.body.error.code).toBe("invalid_input");
  });
});
