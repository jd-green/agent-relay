import { describe, expect, it } from "vitest";
import { authenticate } from "../../src/auth";
import { loadConfig } from "../../src/config";
import { aliases, displayName, resolveRole } from "../../src/roles";
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
    const body = await response.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32001);
  });

  it("challenges a presented but unknown token with error=\"invalid_token\"", async () => {
    const invalid = 'Bearer realm="agent-relay", error="invalid_token", error_description="unknown or rotated relay token"';
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await mcp("x".repeat(40), ping)).headers.get("www-authenticate")).toBe(invalid);
    expect((await mcp(null, ping, `/mcp/${"y".repeat(40)}`)).headers.get("www-authenticate")).toBe(invalid);
    expect((await mcp(null, ping, "/mcp/%E0%A4%A")).headers.get("www-authenticate")).toBe(invalid);
    // No token at all: the bare challenge (RFC 6750 sends no error code then).
    for (const response of [await mcp(null, ping), await mcp(null, ping, "/mcp/")]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="agent-relay"');
    }
    const basic = await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Basic ${TOKENS.human}` }, body: JSON.stringify(ping) });
    expect(basic.headers.get("www-authenticate")).toBe('Bearer realm="agent-relay"');
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

describe("HUMAN_NAME collisions", () => {
  const named = (humanName: string) => ({ ...loadConfig(env), humanName });

  it("never adds a HUMAN_NAME that is a role id, an alias or `relay` as an alias", () => {
    for (const name of ["Relay", "relay", "Orchestrator", "dev", "CD", "Creative Director", "Full-Stack Developer", "orch", "James"]) {
      const config = named(name);
      expect(aliases("human", config), name).toEqual(["james"]);
      expect(displayName("human", config), name).toBe(name);
    }
    expect(aliases("human", named("Ada Lovelace"))).toEqual(["james", "ada-lovelace"]);
  });

  it("keeps every role name pointing at its own role", () => {
    expect(resolveRole("relay", named("Relay"))).toBeNull();
    expect(resolveRole("Relay", named("Relay"))).toBeNull();
    expect(resolveRole(" RELAY ", named("relay"))).toBeNull();
    expect(resolveRole("dev", named("Dev"))).toBe("developer");
    expect(resolveRole("orchestrator", named("Orchestrator"))).toBe("orchestrator");
    expect(resolveRole("Creative Director", named("Creative Director"))).toBe("creative-director");
    expect(resolveRole("cd", named("CD"))).toBe("creative-director");
    // The human is still reachable by id and the fixed alias.
    expect(resolveRole("human", named("Relay"))).toBe("human");
    expect(resolveRole("james", named("Dev"))).toBe("human");
    expect(resolveRole("Ada Lovelace", named("Ada Lovelace"))).toBe("human");
  });

  it("refuses `relay` as a recipient whatever HUMAN_NAME is", async () => {
    const build = await createBuild();
    const toRelay = await callRaw("developer", "send", { build_id: build.build_id, to_role: "Relay", type: "status", body: "hi" });
    expect(toRelay.body.error.code).toBe("invalid_input");
  });
});
