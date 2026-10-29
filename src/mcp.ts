import creativeDirector from "../protocol/mcp/creative-director.md";
import developer from "../protocol/mcp/developer.md";
import human from "../protocol/mcp/human.md";
import orchestrator from "../protocol/mcp/orchestrator.md";
import { RelayError } from "./errors";
import type { Role } from "./roles";
import { callTool, findTool, inputSchema, toolsFor, type ToolContext } from "./tools";
import { NAME, VERSION } from "./version";

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
/** Streamable HTTP: a request without an MCP-Protocol-Version header is assumed to use 2025-03-26. */
export const ASSUMED_PROTOCOL_VERSION = "2025-03-26";
/** Batches were removed in 2025-06-18; the versions before it may send at most this many messages in one. */
export const MAX_BATCH_MESSAGES = 20;
const LAST_BATCH_VERSION = "2025-03-26";

// Clients may cut server instructions short (Claude Code keeps 4,096 chars), so each role gets a
// short role-first digest. The full protocol lives in the Project instructions, not here.
const INSTRUCTIONS: Record<Role, string> = {
  orchestrator: orchestrator.trim(),
  "creative-director": creativeDirector.trim(),
  developer: developer.trim(),
  human: human.trim(),
};

export function instructionsFor(role: Role): string {
  return INSTRUCTIONS[role];
}

export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/** What the transport sends back: a JSON-RPC body (null = nothing to answer, HTTP 202) and its HTTP status. */
export interface RpcReply {
  status: number;
  body: JsonRpcResponse | JsonRpcResponse[] | null;
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
/** Server-defined code used on 401 responses. */
export const RPC_UNAUTHORIZED = -32001;

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function invalidRequest(id: JsonRpcId, detail: string): JsonRpcResponse {
  return rpcError(id, RPC_INVALID_REQUEST, `Invalid Request: ${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP request ids are strings or integers, never null or fractional. */
function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

/** A client's reply to a server request: an id (null only on errors) and exactly one of result or error. */
function isClientResponse(message: Record<string, unknown>): boolean {
  const hasResult = "result" in message;
  const hasError = "error" in message;
  if (hasResult === hasError || !("id" in message)) return false;
  return isRequestId(message.id) || (hasError && message.id === null);
}

/**
 * Handles one parsed JSON-RPC payload (a message or a batch array) sent with
 * `protocolVersion` (the MCP-Protocol-Version header, or the assumed default).
 * A body of null means nothing needs answering (notifications and client responses only).
 */
export async function handleRpcPayload(ctx: ToolContext, payload: unknown, protocolVersion: string): Promise<RpcReply> {
  if (!Array.isArray(payload)) {
    const response = await handleMessage(ctx, payload);
    if (response === null) return { status: 202, body: null };
    // A message the server can't accept (including a rejected notification) is an HTTP error too.
    return { status: response.error?.code === RPC_INVALID_REQUEST ? 400 : 200, body: response };
  }
  if (protocolVersion > LAST_BATCH_VERSION) {
    return { status: 400, body: invalidRequest(null, `batches are not supported in protocol version ${protocolVersion}`) };
  }
  if (payload.length === 0) return { status: 400, body: invalidRequest(null, "empty batch") };
  if (payload.length > MAX_BATCH_MESSAGES) {
    return { status: 400, body: invalidRequest(null, `a batch may hold at most ${MAX_BATCH_MESSAGES} messages`) };
  }
  // One at a time, so a batch costs no more than the same calls sent one by one.
  const answered: JsonRpcResponse[] = [];
  for (const message of payload) {
    const response = await handleMessage(ctx, message);
    if (response !== null) answered.push(response);
  }
  return answered.length > 0 ? { status: 200, body: answered } : { status: 202, body: null };
}

async function handleMessage(ctx: ToolContext, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return invalidRequest(null, "expected a JSON-RPC 2.0 message");
  if (!("method" in message)) {
    // A response from the client (we never send requests to it): nothing to answer.
    if (isClientResponse(message)) return null;
    return invalidRequest(null, "a message needs a method, or an id and exactly one of result or error");
  }
  const hasId = "id" in message;
  if (hasId && !isRequestId(message.id)) return invalidRequest(null, "id must be a string or an integer");
  const id = hasId ? (message.id as string | number) : null;
  if (typeof message.method !== "string") return invalidRequest(id, "method must be a string");
  // Notifications (no id) never get a response.
  if (!hasId) return null;

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
    typeof requested === "string" && isSupportedProtocolVersion(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
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
