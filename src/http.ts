import page from "./ui/ledger.html";
import { authenticate, bearerToken } from "./auth";
import { loadConfig } from "./config";
import { ERROR_STATUS, RelayError, fail, type ErrorCode } from "./errors";
import { RPC_INVALID_REQUEST, RPC_PARSE_ERROR, RPC_UNAUTHORIZED, handleRpcPayload, rpcError } from "./mcp";
import { enabledTokens, type Role } from "./roles";
import { SpikeEventInput, WakeInput, describeIssues } from "./schemas";
import { assertNoSecrets } from "./secrets";
import { relayStub } from "./stubs";
import { callTool, type ToolContext } from "./tools";
import { NAME, VERSION } from "./version";

const MAX_BODY_BYTES = 1_000_000;
const MAX_SPIKE_DETAIL_BYTES = 4096;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "access-control-max-age": "86400",
};

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function ok(result: unknown): Response {
  return json({ ok: true, result });
}

function errorResponse(code: ErrorCode, message: string): Response {
  return json({ ok: false, error: { code, message } }, ERROR_STATUS[code]);
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow, ...CORS_HEADERS } });
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) fail("invalid_input", "request body is too large");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_input", "request body is not valid JSON");
  }
}

/** Query parameters with empty values treated as absent. */
function queryParams(url: URL): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) if (value !== "") params.set(key, value);
  return params;
}

function flag(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "1" || value.toLowerCase() === "true";
}

function integer(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function requireRole(env: Env, token: string | null): Promise<Role> {
  const role = await authenticate(env, token);
  if (!role) fail("unauthorized", "missing or unknown token; send Authorization: Bearer <role token>");
  return role;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    if (path === "/mcp" || path.startsWith("/mcp/")) return await handleMcp(request, env, path);
    if (path.startsWith("/api/")) return await handleApi(request, env, url, path);
    if (path.startsWith("/spike/")) return await handleSpike(request, env, url, path);
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    switch (path) {
      case "/":
        return new Response(page, { headers: PAGE_HEADERS });
      case "/health":
        return json({ ok: true, name: NAME, version: VERSION });
      case "/spike":
        return Response.redirect(new URL("/#spike", url).toString(), 302);
      default:
        return errorResponse("not_found", `no route for ${path}`);
    }
  } catch (err) {
    if (err instanceof RelayError) return errorResponse(err.code, err.message);
    console.error("unhandled error", err);
    return json({ ok: false, error: { code: "internal", message: "internal error" } }, 500);
  }
}

// ---------------------------------------------------------------- MCP transport

async function handleMcp(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  // claude.ai custom connectors cannot always set headers, so the token may also be the last path segment.
  const pathToken = path.startsWith("/mcp/") ? decodeSegment(path.slice("/mcp/".length)) : null;
  const role = (await authenticate(env, bearerToken(request))) ?? (await authenticate(env, pathToken));
  if (!role) {
    return json(rpcError(null, RPC_UNAUTHORIZED, "Unauthorized: missing or unknown token"), 401, {
      "www-authenticate": 'Bearer realm="agent-relay"',
    });
  }

  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) return json(rpcError(null, RPC_INVALID_REQUEST, "Request too large"), 400);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(rpcError(null, RPC_PARSE_ERROR, "Parse error"), 400);
  }
  const ctx: ToolContext = { env, config: loadConfig(env), role };
  const response = await handleRpcPayload(ctx, payload);
  return response === null ? new Response(null, { status: 202, headers: CORS_HEADERS }) : json(response);
}

// ---------------------------------------------------------------- JSON API

async function handleApi(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const role = await requireRole(env, bearerToken(request));
  const ctx: ToolContext = { env, config: loadConfig(env), role };
  const query = queryParams(url);
  const segments = path.split("/").slice(2).map(decodeSegment);
  if (segments.includes(null)) fail("invalid_input", "malformed percent-encoding in the URL path");
  const [resource, id, ...rest] = segments as string[];

  if (resource === "call" && id !== undefined && rest.length === 0) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return ok(await callTool(ctx, id, await readJson(request)));
  }
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (resource === "me" && id === undefined) return ok(await callTool(ctx, "whoami", {}));
  if (resource === "builds" && id === undefined) {
    return ok(await callTool(ctx, "build_list", { include_closed: flag(query.get("include_closed")) }));
  }
  if (resource === "builds" && id !== undefined && rest.length === 0) {
    return ok(await callTool(ctx, "ledger_get", { build_id: id }));
  }
  if (resource === "inbox" && id === undefined) {
    return ok(
      await callTool(ctx, "inbox", {
        build_id: query.get("build_id"),
        since: integer(query.get("since")),
        peek: flag(query.get("peek")),
        limit: integer(query.get("limit")),
        session_ref: query.get("session_ref"),
      }),
    );
  }
  return errorResponse("not_found", `no route for ${path}`);
}

// ---------------------------------------------------------------- spike endpoints

async function handleSpike(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const role = await requireRole(env, bearerToken(request));
  const relay = relayStub(env);
  const query = queryParams(url);
  const humanOnly = (what: string) => {
    if (role !== "human") fail("forbidden", `only the human may ${what}`);
  };

  if (path === "/spike/events") {
    if (request.method === "POST") {
      const parsed = SpikeEventInput.safeParse(await readJson(request));
      if (!parsed.success) fail("invalid_input", describeIssues(parsed.error));
      const detailBytes = byteLength(JSON.stringify(parsed.data.detail ?? null));
      if (detailBytes > MAX_SPIKE_DETAIL_BYTES) fail("invalid_input", `detail must be at most ${MAX_SPIKE_DETAIL_BYTES} bytes of JSON`);
      assertNoSecrets(parsed.data, enabledTokens(env));
      return ok({ event: await relay.addSpikeEvent(role, parsed.data) });
    }
    if (request.method === "GET") {
      humanOnly("read spike events");
      const since = query.get("since");
      const limit = integer(query.get("limit")) ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("invalid_input", "limit must be an integer from 1 to 1000");
      const sinceQuery =
        since === undefined ? {} : /^\d+$/.test(since) ? { since_id: Number(since) } : { since_ms: Date.parse(since) };
      if (Number.isNaN(sinceQuery.since_ms)) fail("invalid_input", "since must be an event id or an ISO-8601 time");
      return ok({ events: await relay.listSpikeEvents({ ...sinceQuery, limit }) });
    }
    return methodNotAllowed("GET, POST");
  }

  if (path === "/spike/wake") {
    if (request.method === "POST") {
      humanOnly("create wake requests");
      const parsed = WakeInput.safeParse(await readJson(request));
      if (!parsed.success) fail("invalid_input", describeIssues(parsed.error));
      assertNoSecrets(parsed.data, enabledTokens(env));
      return ok({ wake: await relay.createWake(role, parsed.data) });
    }
    if (request.method === "GET") {
      return ok({ wakes: await relay.consumeWakes(query.get("session_id") ?? null, role) });
    }
    return methodNotAllowed("GET, POST");
  }

  return errorResponse("not_found", `no route for ${path}`);
}
