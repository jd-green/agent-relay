import page from "./ui/ledger.html";
import { authenticate, bearerToken } from "./auth";
import { loadConfig } from "./config";
import { ERROR_STATUS, RelayError, fail, type ErrorCode } from "./errors";
import {
  ASSUMED_PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  RPC_UNAUTHORIZED,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleRpcPayload,
  isSupportedProtocolVersion,
  rpcError,
} from "./mcp";
import { enabledTokens, type Role } from "./roles";
import { SpikeEventInput, WakeInput, describeIssues } from "./schemas";
import { assertNoSecrets } from "./secrets";
import { relayStub } from "./stubs";
import { callTool, type ToolContext } from "./tools";
import { NAME, VERSION } from "./version";

const MAX_BODY_BYTES = 1_000_000;
const MAX_SPIKE_DETAIL_BYTES = 4096;

// CORS covers the JSON API and the spike endpoints. /mcp sends none: MCP clients are not browsers.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
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

/** Routes outside /mcp, /api and /spike/; they answer GET and HEAD only. */
const PAGE_ROUTES = new Set(["/", "/health", "/spike"]);

// RFC 6750: a presented token that doesn't authenticate gets error="invalid_token".
const MCP_CHALLENGE = 'Bearer realm="agent-relay"';
const MCP_INVALID_TOKEN_CHALLENGE = `${MCP_CHALLENGE}, error="invalid_token", error_description="unknown or rotated relay token"`;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...extra } });
}

/** A JSON-RPC response on /mcp (no CORS headers). */
function mcpJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function ok(result: unknown): Response {
  return json({ ok: true, result });
}

function errorResponse(code: ErrorCode, message: string): Response {
  return json({ ok: false, error: { code, message } }, ERROR_STATUS[code]);
}

/** Unknown routes never echo the path: a /mcp/<token> probe would put the token in the reply. */
function notFound(): Response {
  return errorResponse("not_found", "no such route");
}

function methodNotAllowed(allow: string, cors = true): Response {
  return new Response(null, { status: 405, headers: { allow, ...(cors ? CORS_HEADERS : {}) } });
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

  if (path === "/mcp" || path.startsWith("/mcp/")) {
    try {
      return await handleMcp(request, env, url, path);
    } catch (err) {
      console.error("unhandled MCP error", err);
      return mcpJson(rpcError(null, RPC_INTERNAL_ERROR, "Internal error"), 500);
    }
  }

  try {
    if (path.startsWith("/api/") || path.startsWith("/spike/")) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return path.startsWith("/api/") ? await handleApi(request, env, url, path) : await handleSpike(request, env, url, path);
    }
    // 404 is decided by the path before 405 by the method, so OAuth discovery probes
    // (POST /register, GET /.well-known/...) get a plain not_found.
    if (!PAGE_ROUTES.has(path)) return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    switch (path) {
      case "/":
        return new Response(page, { headers: PAGE_HEADERS });
      case "/health":
        return json({ ok: true, name: NAME, version: VERSION });
      default:
        return Response.redirect(new URL("/#spike", url).toString(), 302);
    }
  } catch (err) {
    if (err instanceof RelayError) return errorResponse(err.code, err.message);
    console.error("unhandled error", err);
    return json({ ok: false, error: { code: "internal", message: "internal error" } }, 500);
  }
}

// ---------------------------------------------------------------- MCP transport

/** True when the request has no Origin header or its Origin is the relay's own. */
// Claude's own web origins, in case a connector request is ever proxied with one.
const CLAUDE_ORIGINS = new Set(["https://claude.ai", "https://claude.com"]);

function sameOriginOrNone(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const parsed = new URL(origin).origin;
    return parsed === url.origin || CLAUDE_ORIGINS.has(parsed);
  } catch {
    return false;
  }
}

async function handleMcp(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  // Streamable HTTP: servers MUST validate Origin (DNS rebinding). MCP clients send none; a page on
  // another site gets 403.
  if (!sameOriginOrNone(request, url)) {
    return mcpJson(rpcError(null, RPC_INVALID_REQUEST, "Forbidden: cross-origin requests are not allowed"), 403);
  }
  if (request.method !== "POST") return methodNotAllowed("POST", false);
  // claude.ai custom connectors cannot always set headers, so the token may also be the last path segment.
  const pathSegment = path.startsWith("/mcp/") ? path.slice("/mcp/".length) : "";
  const headerToken = bearerToken(request);
  const role = (await authenticate(env, headerToken)) ?? (await authenticate(env, decodeSegment(pathSegment)));
  if (!role) {
    const presented = headerToken !== null || pathSegment !== "";
    return mcpJson(rpcError(null, RPC_UNAUTHORIZED, "Unauthorized: missing or unknown token"), 401, {
      "www-authenticate": presented ? MCP_INVALID_TOKEN_CHALLENGE : MCP_CHALLENGE,
    });
  }

  const requestedVersion = request.headers.get("mcp-protocol-version");
  if (requestedVersion !== null && !isSupportedProtocolVersion(requestedVersion)) {
    const supported = SUPPORTED_PROTOCOL_VERSIONS.join(", ");
    return mcpJson(rpcError(null, RPC_INVALID_REQUEST, `Bad Request: unsupported MCP-Protocol-Version; supported: ${supported}`), 400);
  }

  const text = await request.text();
  if (byteLength(text) > MAX_BODY_BYTES) return mcpJson(rpcError(null, RPC_INVALID_REQUEST, "Request too large"), 400);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return mcpJson(rpcError(null, RPC_PARSE_ERROR, "Parse error"), 400);
  }
  const ctx: ToolContext = { env, config: loadConfig(env), role };
  const reply = await handleRpcPayload(ctx, payload, requestedVersion ?? ASSUMED_PROTOCOL_VERSION);
  return reply.body === null ? new Response(null, { status: 202 }) : mcpJson(reply.body, reply.status);
}

// ---------------------------------------------------------------- JSON API

interface ApiRoute {
  method: "GET" | "POST";
  run: () => Promise<unknown>;
}

async function handleApi(request: Request, env: Env, url: URL, path: string): Promise<Response> {
  const role = await requireRole(env, bearerToken(request));
  const ctx: ToolContext = { env, config: loadConfig(env), role };
  const query = queryParams(url);
  const segments = path.split("/").slice(2).map(decodeSegment);
  if (segments.includes(null)) fail("invalid_input", "malformed percent-encoding in the URL path");
  const [resource, id, ...rest] = segments as string[];

  // Match the route first: 405 is only for a known route called with the wrong method.
  let route: ApiRoute | null = null;
  if (resource === "call" && id !== undefined && rest.length === 0) {
    route = { method: "POST", run: async () => callTool(ctx, id, await readJson(request)) };
  } else if (resource === "me" && id === undefined) {
    route = { method: "GET", run: () => callTool(ctx, "whoami", {}) };
  } else if (resource === "builds" && id === undefined) {
    route = { method: "GET", run: () => callTool(ctx, "build_list", { include_closed: flag(query.get("include_closed")) }) };
  } else if (resource === "builds" && id !== undefined && rest.length === 0) {
    route = { method: "GET", run: () => callTool(ctx, "ledger_get", { build_id: id }) };
  } else if (resource === "inbox" && id === undefined) {
    route = {
      method: "GET",
      run: () =>
        callTool(ctx, "inbox", {
          build_id: query.get("build_id"),
          since: integer(query.get("since")),
          peek: flag(query.get("peek")),
          limit: integer(query.get("limit")),
          session_ref: query.get("session_ref"),
        }),
    };
  }
  if (!route) return notFound();
  if (request.method !== route.method) return methodNotAllowed(route.method);
  return ok(await route.run());
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

  return notFound();
}
