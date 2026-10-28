import { CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import creativeDirectorDigest from "../../protocol/mcp/creative-director.md";
import developerDigest from "../../protocol/mcp/developer.md";
import humanDigest from "../../protocol/mcp/human.md";
import orchestratorDigest from "../../protocol/mcp/orchestrator.md";
import { loadConfig } from "../../src/config";
import { instructionsFor } from "../../src/mcp";
import { ROLES, displayName } from "../../src/roles";
import { TOKENS, createBuild, fetchWorker, mcp, rpc, useCleanState, type Json } from "./helpers";

useCleanState();

const TOOLS_BY_ROLE = {
  human: [
    "whoami",
    "build_create",
    "build_list",
    "send",
    "inbox",
    "ledger_get",
    "ledger_update",
    "gate_request",
    "gate_decide",
    "build_control",
    "kill_switch",
  ],
  orchestrator: ["whoami", "build_create", "build_list", "send", "inbox", "ledger_get", "ledger_update", "gate_request"],
  "creative-director": ["whoami", "build_list", "send", "inbox", "ledger_get", "ledger_update"],
  developer: ["whoami", "build_list", "send", "inbox", "ledger_get", "ledger_update"],
} as const;

describe("MCP initialize", () => {
  it("echoes every supported protocol version", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const body = await rpc("developer", "initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(body.result.protocolVersion).toBe(version);
    }
  });

  it("answers 2025-06-18 for an unknown version", async () => {
    const body = await rpc("developer", "initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("returns capabilities, server info and the role's own instructions digest", async () => {
    const cases = [
      ["orchestrator", orchestratorDigest],
      ["creative-director", creativeDirectorDigest],
      ["developer", developerDigest],
      ["human", humanDigest],
    ] as const;
    for (const [role, digest] of cases) {
      const body = await rpc(role, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const result = InitializeResultSchema.parse(body.result);
      expect(result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(result.serverInfo).toEqual({ name: "agent-relay", version: "0.1.0" });
      expect(result.instructions).toBe(digest.trim());
      expect(result.instructions).toBe(instructionsFor(role));
    }
  });

  // Claude Code keeps only the first 4,096 chars of server instructions (the digests aim for 3,900).
  it("keeps every role's instructions within 4,096 chars, naming the role first", () => {
    const config = loadConfig(env);
    for (const role of ROLES) {
      const text = instructionsFor(role);
      const name = displayName(role, config).toLowerCase();
      expect(text.length, role).toBeLessThanOrEqual(4096);
      expect(text.toLowerCase(), `${role} instructions name "${name}"`).toContain(name);
      const firstLine = text.split("\n").find((line) => line.trim() !== "")?.toLowerCase() ?? "";
      expect(firstLine.includes(role) || firstLine.includes(name), `${role} instructions start with the role: ${firstLine}`).toBe(true);
    }
  });

  it("rejects non-object params with -32602", async () => {
    const body = await rpc("developer", "initialize", ["2025-06-18"]);
    expect(body.error.code).toBe(-32602);
  });
});

/** POST to /mcp as the developer with extra headers. */
function post(payload: unknown, headers: Record<string, string> = {}, path = "/mcp"): Promise<Response> {
  return fetchWorker(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKENS.developer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("MCP transport", () => {
  it("answers notifications with an empty 202", async () => {
    const response = await mcp(TOKENS.developer, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers ping with an empty result", async () => {
    const body = await rpc("developer", "ping", undefined, "abc");
    expect(body).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  it("returns empty resource and prompt lists", async () => {
    expect((await rpc("developer", "resources/list")).result).toEqual({ resources: [] });
    expect((await rpc("developer", "prompts/list")).result).toEqual({ prompts: [] });
  });

  it("answers an unknown method with -32601", async () => {
    const body = await rpc("developer", "sampling/createMessage", {});
    expect(body.error.code).toBe(-32601);
  });

  it("answers malformed JSON with -32700", async () => {
    const response = await mcp(TOKENS.developer, "{not json");
    expect(response.status).toBe(400);
    const body = await response.json<Json>();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  });

  it("answers a message that is not JSON-RPC 2.0 with -32600 and HTTP 400", async () => {
    const response = await mcp(TOKENS.developer, { id: 1, method: "ping" });
    expect(response.status).toBe(400);
    const body = await response.json<Json>();
    expect(body.error.code).toBe(-32600);
  });

  it("refuses GET and DELETE with 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetchWorker("/mcp", { method, headers: { authorization: `Bearer ${TOKENS.developer}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("answers a body over 1 MB with -32600", async () => {
    const response = await post({ ...PING, params: { pad: "x".repeat(1_000_001) } });
    expect(response.status).toBe(400);
    expect((await response.json<Json>()).error.code).toBe(-32600);
  });
});

describe("MCP Origin check", () => {
  it("refuses a cross-origin request with 403 before anything else", async () => {
    for (const origin of ["https://evil.example", "https://claude.ai.evil.example", "http://relay.test", "https://relay.test:8443", "null"]) {
      const response = await post(PING, { origin });
      expect(response.status, origin).toBe(403);
      expect(await response.json<Json>()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Forbidden: cross-origin requests are not allowed" },
      });
    }
    // Even without a token, and on the path-token route and other methods.
    const noToken = await fetchWorker("/mcp", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify(PING) });
    expect(noToken.status).toBe(403);
    expect((await post(PING, { origin: "https://evil.example" }, `/mcp/${TOKENS.developer}`)).status).toBe(403);
    expect((await fetchWorker("/mcp", { method: "GET", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("accepts a same-origin request, Claude's own origins and one with no Origin", async () => {
    for (const headers of [{ origin: "https://relay.test" }, { origin: "https://claude.ai" }, { origin: "https://claude.com" }, {}] as Record<string, string>[]) {
      const response = await post(PING, headers);
      expect(response.status).toBe(200);
      expect(await response.json<Json>()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    }
  });
});

describe("MCP responses carry no CORS headers", () => {
  it("on success, notification, error, 401, 403, 405 and OPTIONS", async () => {
    const responses = {
      ok: await post(PING),
      notification: await post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      parseError: await post("{nope"),
      unauthorized: await mcp(null, PING),
      forbidden: await post(PING, { origin: "https://evil.example" }),
      get: await fetchWorker("/mcp", { method: "GET" }),
      options: await fetchWorker("/mcp", { method: "OPTIONS" }),
      preflight: await fetchWorker("/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    };
    expect(Object.fromEntries(Object.entries(responses).map(([name, r]) => [name, r.status]))).toEqual({
      ok: 200,
      notification: 202,
      parseError: 400,
      unauthorized: 401,
      forbidden: 403,
      get: 405,
      options: 405,
      preflight: 403,
    });
    for (const [name, response] of Object.entries(responses)) {
      for (const header of response.headers.keys()) expect(header, name).not.toMatch(/^access-control-/);
    }
  });
});

describe("MCP-Protocol-Version header", () => {
  it("accepts every supported version and a missing header", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const response = await post(PING, { "mcp-protocol-version": version });
      expect(response.status, version).toBe(200);
    }
    expect((await post(PING)).status).toBe(200);
  });

  it("answers an unsupported version with HTTP 400 and -32600", async () => {
    for (const version of ["1999-01-01", "2026-07-28", "", "latest"]) {
      const response = await post(PING, { "mcp-protocol-version": version });
      expect(response.status, version).toBe(400);
      const body = await response.json<Json>();
      expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
      expect(body.error.message).toBe(
        "Bad Request: unsupported MCP-Protocol-Version; supported: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05",
      );
    }
  });

  it("is checked after auth", async () => {
    const response = await mcp(null, PING);
    expect(response.status).toBe(401);
    const bad = await fetchWorker("/mcp", { method: "POST", headers: { "mcp-protocol-version": "1999-01-01" }, body: JSON.stringify(PING) });
    expect(bad.status).toBe(401);
  });
});

describe("JSON-RPC strictness", () => {
  it("accepts string and integer ids", async () => {
    for (const id of ["abc", "", 0, 7, -3, 2 ** 40]) {
      const response = await post({ jsonrpc: "2.0", id, method: "ping" });
      expect(response.status, String(id)).toBe(200);
      expect(await response.json<Json>()).toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });

  it("rejects null, fractional and non-scalar ids with -32600, id null and HTTP 400", async () => {
    for (const id of [null, 1.5, true, { n: 1 }, [1]]) {
      const response = await post({ jsonrpc: "2.0", id, method: "ping" });
      expect(response.status, JSON.stringify(id)).toBe(400);
      const body = await response.json<Json>();
      expect(body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
      expect(body.result).toBeUndefined();
    }
  });

  it("rejects a message with neither a method nor a result or error", async () => {
    for (const message of [{ jsonrpc: "2.0" }, { jsonrpc: "2.0", id: 4 }, { jsonrpc: "2.0", id: 4, result: {}, error: { code: 1, message: "x" } }, {}]) {
      const response = await post(message);
      expect(response.status, JSON.stringify(message)).toBe(400);
      expect(await response.json<Json>()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    }
  });

  it("accepts client responses with 202", async () => {
    for (const message of [
      { jsonrpc: "2.0", id: 9, result: {} },
      { jsonrpc: "2.0", id: "x", error: { code: -32601, message: "no" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse" } },
    ]) {
      const response = await post(message);
      expect(response.status, JSON.stringify(message)).toBe(202);
      expect(await response.text()).toBe("");
    }
    // A success response always names the request it answers.
    expect((await post({ jsonrpc: "2.0", id: null, result: {} })).status).toBe(400);
  });

  it("answers a notification it can't accept with HTTP 400", async () => {
    const response = await post({ jsonrpc: "2.0", method: 42 });
    expect(response.status).toBe(400);
    expect(await response.json<Json>()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  });

  it("names the id when only the method is invalid", async () => {
    const response = await post({ jsonrpc: "2.0", id: 5, method: ["ping"] });
    expect(response.status).toBe(400);
    expect(await response.json<Json>()).toMatchObject({ id: 5, error: { code: -32600 } });
  });
});

describe("JSON-RPC batches", () => {
  const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });

  for (const headers of [{}, { "mcp-protocol-version": "2025-03-26" }, { "mcp-protocol-version": "2024-11-05" }] as Record<string, string>[]) {
    it(`answers a batch array with an array of responses (${headers["mcp-protocol-version"] ?? "no version header"})`, async () => {
      const response = await post(
        [
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "nope" },
          { jsonrpc: "2.0", id: null, method: "ping" },
        ],
        headers,
      );
      expect(response.status).toBe(200);
      const body = await response.json<Json[]>();
      expect(body.map((item) => item.id)).toEqual([1, 2, 3, null]);
      expect(body[0].result).toEqual({});
      expect(body[1].result.tools.length).toBeGreaterThan(0);
      expect(body[2].error.code).toBe(-32601);
      expect(body[3].error.code).toBe(-32600);
    });
  }

  it("answers a batch of notifications only with 202", async () => {
    const response = await mcp(TOKENS.developer, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(response.status).toBe(202);
  });

  it("refuses batches for protocol versions from 2025-06-18 on", async () => {
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const response = await post([ping(1)], { "mcp-protocol-version": version });
      expect(response.status, version).toBe(400);
      expect(await response.json<Json>()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: `Invalid Request: batches are not supported in protocol version ${version}` },
      });
    }
  });

  it("accepts up to 20 messages and refuses 21 or an empty batch", async () => {
    const twenty = await post(Array.from({ length: 20 }, (_, i) => ping(i + 1)));
    expect(twenty.status).toBe(200);
    expect((await twenty.json<Json[]>()).map((item) => item.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    const tooMany = await post(Array.from({ length: 21 }, (_, i) => ping(i + 1)));
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json<Json>()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: a batch may hold at most 20 messages" },
    });

    const empty = await post([]);
    expect(empty.status).toBe(400);
    expect((await empty.json<Json>()).error.code).toBe(-32600);
  });

  it("runs batch elements in order", async () => {
    const build = await createBuild();
    const create = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "ledger_update", arguments: { build_id: build.build_id, title: `Task ${id}`, assignee: "developer" } },
    });
    const response = await post([create(1), create(2), create(3)], { authorization: `Bearer ${TOKENS.orchestrator}` });
    const body = await response.json<Json[]>();
    expect(body.map((item) => [item.result.structuredContent.task.id, item.result.structuredContent.task.title])).toEqual([
      ["T1", "Task 1"],
      ["T2", "Task 2"],
      ["T3", "Task 3"],
    ]);
  });
});

describe("MCP tools/list", () => {
  for (const [role, expected] of Object.entries(TOOLS_BY_ROLE)) {
    it(`lists only the tools ${role} may call, with valid schemas`, async () => {
      const body = await rpc(role as keyof typeof TOOLS_BY_ROLE, "tools/list");
      const { tools } = ListToolsResultSchema.parse(body.result);
      expect(tools.map((tool) => tool.name)).toEqual(expected);
      for (const tool of tools) {
        expect(tool.description?.length).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.annotations).toMatchObject({ openWorldHint: false });
        // The schema must round-trip into a working validator.
        z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        for (const name of tool.inputSchema.required ?? []) {
          expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(name);
        }
      }
    });
  }

  it("describes inputs precisely enough to validate calls", async () => {
    const body = await rpc("developer", "tools/list");
    const send = body.result.tools.find((tool: Json) => tool.name === "send");
    expect(send.inputSchema.required).toEqual(["build_id", "to_role", "type", "body"]);
    expect(send.inputSchema.properties.type.enum).toEqual(["task", "handoff", "review_request", "verdict", "question", "status"]);
    const validator = z.fromJSONSchema(send.inputSchema);
    const valid = { build_id: "b-abcdefghij", to_role: "cd", type: "status", body: "hi" };
    expect(validator.safeParse(valid).success).toBe(true);
    expect(validator.safeParse({ ...valid, type: "shout" }).success).toBe(false);
    expect(validator.safeParse({ ...valid, build_id: "nope" }).success).toBe(false);

    const whoami = body.result.tools.find((tool: Json) => tool.name === "whoami");
    expect(whoami.annotations.readOnlyHint).toBe(true);
  });
});

describe("MCP tools/call", () => {
  it("returns the result as text and structuredContent", async () => {
    const body = await rpc("developer", "tools/call", { name: "whoami", arguments: {} });
    const result = CallToolResultSchema.parse(body.result);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ role: "developer", display_name: "Full-Stack Developer" });
    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  });

  it("runs write tools", async () => {
    const body = await rpc("human", "tools/call", {
      name: "build_create",
      arguments: { title: "MCP build", brief: "From MCP" },
    });
    expect(body.result.structuredContent.status).toBe("planning");
  });

  it("reports tool failures as isError results, not JSON-RPC errors", async () => {
    const forbidden = await rpc("developer", "tools/call", { name: "kill_switch", arguments: { on: true } });
    expect(forbidden.error).toBeUndefined();
    expect(forbidden.result.isError).toBe(true);
    expect(forbidden.result.content[0].text).toMatch(/^forbidden: /);

    const invalid = await rpc("developer", "tools/call", { name: "ledger_get", arguments: { build_id: 42 } });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.result.content[0].text).toMatch(/^invalid_input: build_id/);

    const missing = await rpc("developer", "tools/call", { name: "ledger_get", arguments: { build_id: "b-aaaaaaaaaa" } });
    expect(missing.result.content[0].text).toMatch(/^not_found: /);

    await createBuild();
    const conflict = await rpc("human", "tools/call", { name: "build_create", arguments: { title: "Second", brief: "x" } });
    expect(conflict.result.content[0].text).toMatch(/^conflict: /);
  });

  it("answers bad tools/call params with -32602", async () => {
    expect((await rpc("developer", "tools/call", {})).error.code).toBe(-32602);
    expect((await rpc("developer", "tools/call", { name: "no_such_tool" })).error.code).toBe(-32602);
    expect((await rpc("developer", "tools/call", { name: "whoami", arguments: [1] })).error.code).toBe(-32602);
  });
});
