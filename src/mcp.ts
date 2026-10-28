import protocol from "../protocol/PROTOCOL.md";
import creativeDirector from "../protocol/roles/creative-director.md";
import developer from "../protocol/roles/developer.md";
import human from "../protocol/roles/human.md";
import orchestrator from "../protocol/roles/orchestrator.md";
import { RelayError } from "./errors";
import type { Role } from "./roles";
import { callTool, findTool, inputSchema, toolsFor, type ToolContext } from "./tools";
import { NAME, VERSION } from "./version";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const ROLE_ADDENDA: Record<Role, string> = {
  orchestrator,
  "creative-director": creativeDirector,
  developer,
  human,
};

export function instructionsFor(role: Role): string {
  return `${protocol}\n\n${ROLE_ADDENDA[role]}`;
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
/** Server-defined code used on 401 responses. */
export const RPC_UNAUTHORIZED = -32001;

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

/**
 * Handles one parsed JSON-RPC payload (a message or a batch array). Returns null
 * when nothing needs answering (notifications and client responses only).
 */
export async function handleRpcPayload(
  ctx: ToolContext,
  payload: unknown,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (!Array.isArray(payload)) return handleMessage(ctx, payload);
  if (payload.length === 0) return rpcError(null, RPC_INVALID_REQUEST, "Invalid Request: empty batch");
  const responses = await Promise.all(payload.map((message) => handleMessage(ctx, message)));
  const answered = responses.filter((response): response is JsonRpcResponse => response !== null);
  return answered.length > 0 ? answered : null;
}

async function handleMessage(ctx: ToolContext, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    return rpcError(null, RPC_INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 message");
  }
  // A response from the client (we never send requests to it): nothing to answer.
  if (!("method" in message)) return null;
  const id = "id" in message ? message.id : undefined;
  if (typeof message.method !== "string" || (id !== undefined && !isId(id))) {
    return rpcError(isId(id) ? id : null, RPC_INVALID_REQUEST, "Invalid Request");
  }
  // Notifications (no id) never get a response.
  if (id === undefined) return null;

  const params = message.params;
  try {
    switch (message.method) {
      case "initialize":
        return initialize(ctx, id, params);
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listTools(ctx.role) });
      case "tools/call":
        return await callToolMethod(ctx, id, params);
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  } catch (err) {
    console.error(`MCP ${message.method} failed`, err);
    return rpcError(id, RPC_INTERNAL_ERROR, "Internal error");
  }
}

function initialize(ctx: ToolContext, id: JsonRpcId, params: unknown): JsonRpcResponse {
  if (params !== undefined && !isObject(params)) {
    return rpcError(id, RPC_INVALID_PARAMS, "Invalid params: initialize params must be an object");
  }
  const requested = params?.protocolVersion;
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: NAME, version: VERSION },
    instructions: instructionsFor(ctx.role),
  });
}

function listTools(role: Role) {
  return toolsFor(role).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: { title: tool.title, ...tool.annotations },
  }));
}

async function callToolMethod(ctx: ToolContext, id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
  if (!isObject(params) || typeof params.name !== "string") {
    return rpcError(id, RPC_INVALID_PARAMS, "Invalid params: tools/call needs a tool name");
  }
  if (params.arguments !== undefined && !isObject(params.arguments)) {
    return rpcError(id, RPC_INVALID_PARAMS, "Invalid params: arguments must be an object");
  }
  if (!findTool(params.name)) return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${params.name}`);
  try {
    const result = await callTool(ctx, params.name, params.arguments ?? {});
    return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  } catch (err) {
    if (!(err instanceof RelayError)) throw err;
    return rpcResult(id, { isError: true, content: [{ type: "text", text: `${err.code}: ${err.message}` }] });
  }
}
