import { describe, expect, it } from "vitest";
import page from "../../src/ui/ledger.html";
import { STATUS, TOKENS, api, call, createBuild, fetchWorker, inProgressBuild, send, useCleanState } from "./helpers";

useCleanState();

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("public routes", () => {
  it("GET /health needs no auth", async () => {
    const { status, body } = await api(null, "GET", "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, name: "agent-relay", version: "0.1.0" });
  });

  it("GET / serves the ledger page with a strict CSP", async () => {
    const response = await fetchWorker("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe(page);
  });

  it("GET /spike redirects to the page's spike view", async () => {
    const response = await fetchWorker("/spike", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://relay.test/#spike");
  });

  it("unknown routes are 404 and wrong methods 405", async () => {
    expect((await api(null, "GET", "/nope")).status).toBe(404);
    expect((await api(null, "POST", "/health")).status).toBe(405);
    expect((await api("human", "GET", "/api/call/whoami")).status).toBe(405);
    expect((await api("human", "POST", "/api/me")).status).toBe(405);
    const unknown = await api("human", "GET", "/api/nothing");
    expect(unknown.body.error.code).toBe("not_found");
    const malformed = await api("human", "GET", "/api/builds/%E0%A4%A");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_input");
  });

  it("answers any method on an unknown path with 404 JSON that doesn't echo the path", async () => {
    const probes: [string, string][] = [
      ["POST", "/register"],
      ["POST", "/token"],
      ["GET", "/authorize"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", `/.well-known/oauth-protected-resource/mcp/${TOKENS.developer}`],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/openid-configuration"],
      ["DELETE", "/nope"],
      ["PUT", "/nope"],
      ["PATCH", "/health/x"],
      ["OPTIONS", "/nope"],
      ["HEAD", "/nope"],
      ["POST", "/api"],
      ["POST", "/mcpx"],
    ];
    for (const [method, path] of probes) {
      const response = await fetchWorker(path, { method, body: method === "POST" ? "{}" : undefined });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      if (method === "HEAD") continue;
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: { code: "not_found", message: "no such route" } });
      expect(text).not.toContain(TOKENS.developer);
    }
  });

  it("decides 404 by path before 405 by method under /api and /spike", async () => {
    for (const [method, path] of [
      ["POST", "/api/builds/b-aaaaaaaaaa/tasks"],
      ["DELETE", "/api/nothing"],
      ["GET", "/api/call"],
      ["POST", "/api/call/whoami/extra"],
      ["POST", "/spike/nope"],
    ] as [string, string][]) {
      const { status, body } = await api("human", method, path);
      expect(status, `${method} ${path}`).toBe(404);
      expect(body).toEqual({ ok: false, error: { code: "not_found", message: "no such route" } });
    }
    // Known routes with the wrong method name the methods they allow.
    const allowed = async (method: string, path: string) => (await fetchWorker(path, { method, headers: { authorization: `Bearer ${TOKENS.human}` } })).headers.get("allow");
    expect(await allowed("POST", "/health")).toBe("GET, HEAD");
    expect(await allowed("DELETE", "/")).toBe("GET, HEAD");
    expect(await allowed("GET", "/api/call/whoami")).toBe("POST");
    expect(await allowed("DELETE", "/api/builds")).toBe("GET");
    expect(await allowed("PUT", "/spike/events")).toBe("GET, POST");
  });
});

describe("CORS", () => {
  it("answers preflight requests", async () => {
    const response = await fetchWorker("/api/call/send", {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(response.headers.get("access-control-allow-headers")).toMatch(/Content-Type/);
    expect(response.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers preflight requests on /spike", async () => {
    const response = await fetchWorker("/spike/events", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds CORS headers to API and error responses, never to MCP ones", async () => {
    for (const response of [
      await fetchWorker("/api/me", { headers: { authorization: `Bearer ${TOKENS.human}` } }),
      await fetchWorker("/api/me"),
      await fetchWorker("/api/nothing", { headers: { authorization: `Bearer ${TOKENS.human}` } }),
      await fetchWorker("/spike/wake", { headers: { authorization: `Bearer ${TOKENS.human}` } }),
    ]) {
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    for (const response of [
      await fetchWorker("/mcp", { method: "POST", headers: { authorization: `Bearer ${TOKENS.human}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
      await fetchWorker("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } }),
    ]) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("JSON API routes", () => {
  it("GET /api/me maps to whoami", async () => {
    const { status, body } = await api("developer", "GET", "/api/me");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ role: "developer", display_name: "Full-Stack Developer" });
  });

  it("GET /api/builds maps to build_list", async () => {
    const build = await createBuild();
    await call("human", "build_control", { build_id: build.build_id, action: "cancel" });
    expect((await api("developer", "GET", "/api/builds")).body.result.builds).toEqual([]);
    const closed = await api("developer", "GET", "/api/builds?include_closed=1");
    expect(closed.body.result.builds[0].build_id).toBe(build.build_id);
  });

  it("GET /api/builds/:build_id maps to ledger_get", async () => {
    const { buildId } = await inProgressBuild();
    const { body } = await api("creative-director", "GET", `/api/builds/${buildId}`);
    expect(body.result.build.build_id).toBe(buildId);
    expect(body.result.tasks).toHaveLength(1);
    expect((await api("human", "GET", "/api/builds/b-aaaaaaaaaa")).status).toBe(404);
  });

  it("GET /api/inbox maps query parameters to inbox", async () => {
    const build = await createBuild();
    for (let i = 1; i <= 3; i += 1) {
      await send("human", { build_id: build.build_id, to_role: "developer", type: "status", body: `update ${i}` });
    }
    const peek = await api("developer", "GET", `/api/inbox?build_id=${build.build_id}&peek=1&limit=2&session_ref=mod-poller&since=`);
    expect(peek.body.result.builds[0].messages.map((m: { body: string }) => m.body)).toEqual(["update 1", "update 2"]);
    expect(peek.body.result.builds[0].unread_remaining).toBe(1);
    const all = await api("developer", "GET", "/api/inbox");
    expect(all.body.result.builds[0].messages).toHaveLength(3);
    const since = await api("developer", "GET", `/api/inbox?build_id=${build.build_id}&since=3`);
    expect(since.body.result.builds[0].messages.map((m: { seq: number }) => m.seq)).toEqual([4]);
    const bad = await api("developer", "GET", "/api/inbox?limit=lots");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
  });

  it("POST /api/call/:tool runs any tool", async () => {
    const created = await api("human", "POST", "/api/call/build_create", { title: "Via API", brief: "x" });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ ok: true, result: expect.objectContaining({ title: "Via API", status: "planning" }) });
    const unknown = await api("human", "POST", "/api/call/teleport", {});
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: { code: "not_found", message: 'unknown tool "teleport"' } });
  });

  it("rejects bodies that are not JSON objects", async () => {
    const response = await fetchWorker("/api/call/whoami", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.human}` },
      body: "{oops",
    });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("invalid_input");
    const array = await api("human", "POST", "/api/call/whoami", [1, 2]);
    expect(array.body.error.code).toBe("invalid_input");
  });

  it("maps every error code to its HTTP status", async () => {
    const seen = new Map<string, number>();
    const record = (result: { status: number; body: { error?: { code: string } } }) => {
      if (result.body.error) seen.set(result.body.error.code, result.status);
    };
    record(await api(null, "GET", "/api/me"));
    record(await api("developer", "POST", "/api/call/kill_switch", { on: true }));
    record(await api("developer", "GET", "/api/builds/b-aaaaaaaaaa"));
    record(await api("developer", "POST", "/api/call/send", {}));
    const build = await createBuild({ caps: { max_messages: 11 } });
    record(await api("human", "POST", "/api/call/build_create", { title: "x", brief: "y" }));
    record(await api("developer", "POST", "/api/call/send", { build_id: build.build_id, to_role: "cd", type: "status", body: `${TOKENS.orchestrator}` }));
    const status = { build_id: build.build_id, to_role: "cd", type: "status", body: "x" };
    for (let i = 0; i < 10; i += 1) await api("developer", "POST", "/api/call/send", status);
    record(await api("developer", "POST", "/api/call/send", status));
    await api("orchestrator", "POST", "/api/call/send", status);
    record(await api("orchestrator", "POST", "/api/call/send", status));
    record(await api("orchestrator", "POST", "/api/call/send", status));
    expect(Object.fromEntries(seen)).toEqual(STATUS);
  });
});
