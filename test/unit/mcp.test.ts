import { CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import protocol from "../../protocol/PROTOCOL.md";
import developerAddendum from "../../protocol/roles/developer.md";
import humanAddendum from "../../protocol/roles/human.md";
import orchestratorAddendum from "../../protocol/roles/orchestrator.md";
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

  it("returns capabilities, server info and role-specific instructions", async () => {
    const cases = [
      ["developer", developerAddendum],
      ["orchestrator", orchestratorAddendum],
      ["human", humanAddendum],
    ] as const;
    for (const [role, addendum] of cases) {
      const body = await rpc(role, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const result = InitializeResultSchema.parse(body.result);
      expect(result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(result.serverInfo).toEqual({ name: "agent-relay", version: "0.1.0" });
      expect(result.instructions).toBe(`${protocol}\n\n${addendum}`);
    }
  });

  it("rejects non-object params with -32602", async () => {
    const body = await rpc("developer", "initialize", ["2025-06-18"]);
    expect(body.error.code).toBe(-32602);
  });
});

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

  it("answers a message that is not JSON-RPC 2.0 with -32600", async () => {
    const response = await mcp(TOKENS.developer, { id: 1, method: "ping" });
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

  it("answers a batch array with an array of responses", async () => {
    const response = await mcp(TOKENS.developer, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "nope" },
    ]);
    expect(response.status).toBe(200);
    const body = await response.json<Json[]>();
    expect(body.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(body[0].result).toEqual({});
    expect(body[1].result.tools.length).toBeGreaterThan(0);
    expect(body[2].error.code).toBe(-32601);
  });

  it("answers a batch of notifications only with 202", async () => {
    const response = await mcp(TOKENS.developer, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(response.status).toBe(202);
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
