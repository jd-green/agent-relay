// MCP transport conformance against a real `wrangler dev` relay (DESIGN §10–11): the Origin check,
// MCP-Protocol-Version, unknown routes, the 401 challenge, JSON-RPC strictness and batch limits,
// CORS (on /api, never on /mcp), the official MCP SDK client with header and path auth, a renamed
// human that collides with `relay`, and, with RUN_LIVE=1, Claude Code itself as the client.
//
//   NO_PROXY=127.0.0.1,localhost node --test test/e2e/mcp-spec.test.mjs
//   RUN_LIVE=1 NO_PROXY=127.0.0.1,localhost node --test test/e2e/mcp-spec.test.mjs
//
// The live part runs `claude -p --model haiku` a few times (a few cents); LIVE_MODEL=<alias> changes
// the model and LIVE_KEEP=1 keeps its debug logs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRelay } from "./harness.mjs";
import { ROLES, connect, http } from "./relay-helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIGESTS = Object.fromEntries(ROLES.map((role) => [role, readFileSync(join(REPO, `protocol/mcp/${role}.md`), "utf8").trim()]));
const DISPLAY_NAMES = { orchestrator: "Orchestrator", "creative-director": "Creative Director", developer: "Full-Stack Developer", human: "James" };
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };
const NOT_FOUND = { ok: false, error: { code: "not_found", message: "no such route" } };
const INVALID_TOKEN = 'Bearer realm="agent-relay", error="invalid_token", error_description="unknown or rotated relay token"';

const corsHeaders = (headers) => [...headers.keys()].filter((name) => name.startsWith("access-control-"));

/** POST /mcp as `role` (header auth) with extra headers; the body may be a raw string. */
function post(relay, payload, headers = {}, { role = "developer", path = "/mcp" } = {}) {
  return fetch(`${relay.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${relay.tokens[role]}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function postJson(relay, payload, headers, options) {
  const res = await post(relay, payload, headers, options);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

// =====================================================================================
describe("MCP transport conformance", { concurrency: 1 }, () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(async () => {
    await relay?.stop();
  });

  test("Origin: another origin gets 403, the relay's own origin, Claude's origins and no Origin are accepted", async () => {
    for (const origin of ["https://evil.example", "https://claude.ai.evil.example", "null", relay.url.replace("127.0.0.1", "localhost")]) {
      const res = await postJson(relay, PING, { origin });
      assert.equal(res.status, 403, `Origin ${origin}`);
      assert.deepEqual(res.body, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Forbidden: cross-origin requests are not allowed" } });
      assert.deepEqual(corsHeaders(res.headers), [], "no CORS headers on a 403");
    }
    const viaPath = await postJson(relay, PING, { origin: "https://evil.example", authorization: "" }, { path: `/mcp/${relay.tokens.developer}` });
    assert.equal(viaPath.status, 403, "path-token route");
    const get = await fetch(`${relay.url}/mcp`, { headers: { origin: "https://evil.example" } });
    assert.equal(get.status, 403, "any method");

    for (const headers of [{ origin: relay.url }, { origin: "https://claude.ai" }, { origin: "https://claude.com" }, {}]) {
      const res = await postJson(relay, PING, headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.deepEqual(res.body, { jsonrpc: "2.0", id: 1, result: {} });
    }
  });

  test("MCP-Protocol-Version: unsupported -> 400 JSON-RPC error, supported or absent -> accepted", async () => {
    const supportedList = SUPPORTED.join(", ");
    for (const version of ["1999-01-01", "2026-07-28", "2024-10-07", "garbage"]) {
      const res = await postJson(relay, PING, { "mcp-protocol-version": version });
      assert.equal(res.status, 400, version);
      assert.deepEqual(res.body, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: `Bad Request: unsupported MCP-Protocol-Version; supported: ${supportedList}` },
      });
    }
    // Claude Code's modern-era probe: a plain 400 (not -32022/-32020) makes it fall back to initialize.
    const probe = await postJson(relay, { jsonrpc: "2.0", id: 0, method: "server/discover" }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    assert.equal(probe.status, 400);
    assert.equal(probe.body.error.code, -32600);

    for (const version of SUPPORTED) {
      const res = await postJson(relay, PING, { "mcp-protocol-version": version });
      assert.deepEqual([res.status, res.body], [200, { jsonrpc: "2.0", id: 1, result: {} }], version);
    }
    assert.equal((await postJson(relay, PING)).status, 200, "no header");
  });

  test("unknown routes: 404 JSON for any method, never echoing the path, never 401/405", async () => {
    const token = relay.tokens.developer;
    const probes = [
      ["POST", "/register"],
      ["POST", "/token"],
      ["GET", "/authorize"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", `/.well-known/oauth-protected-resource/mcp/${token}`],
      ["GET", "/.well-known/oauth-authorization-server"],
      ["GET", `/.well-known/oauth-authorization-server/mcp/${token}`],
      ["GET", "/.well-known/openid-configuration"],
      ["GET", "/nope"],
      ["POST", "/nope"],
      ["DELETE", "/nope"],
      ["DELETE", `/nope/${token}`],
      ["PUT", "/health/extra"],
      ["OPTIONS", "/nope"],
    ];
    for (const [method, path] of probes) {
      const res = await http(relay, path, { method, headers: { "content-type": "application/json" }, rawBody: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 404, `${method} ${path.replace(token, "<token>")}`);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(res.body, NOT_FOUND);
      assert.ok(!JSON.stringify(res.body).includes(token), "the body never carries the token");
    }
    // Authenticated unknown API routes are 404 too; 405 is only for known routes.
    for (const [method, path] of [["GET", "/api/nope"], ["POST", "/api/builds/b-aaaaaaaaaa/tasks"], ["DELETE", "/spike/nope"]]) {
      const res = await http(relay, path, { method, role: "human" });
      assert.deepEqual([res.status, res.body], [404, NOT_FOUND], `${method} ${path}`);
    }
    const known = [
      ["POST", "/health", "GET, HEAD"],
      ["DELETE", "/", "GET, HEAD"],
      ["GET", "/api/call/whoami", "POST"],
      ["POST", "/api/me", "GET"],
      ["GET", "/mcp", "POST"],
      ["DELETE", "/mcp", "POST"],
    ];
    for (const [method, path, allow] of known) {
      const res = await http(relay, path, { method, role: "human" });
      assert.deepEqual([res.status, res.headers.get("allow")], [405, allow], `${method} ${path}`);
    }
  });

  test("401 on /mcp: invalid_token challenge for a presented token, bare challenge without one", async () => {
    const bogus = `bogus-${randomBytes(24).toString("base64url")}`;
    for (const [label, res] of [
      ["unknown header token", await postJson(relay, PING, { authorization: `Bearer ${bogus}` })],
      ["unknown path token", await postJson(relay, PING, { authorization: "" }, { path: `/mcp/${bogus}` })],
    ]) {
      assert.equal(res.status, 401, label);
      assert.equal(res.headers.get("www-authenticate"), INVALID_TOKEN, label);
      assert.deepEqual(res.body, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: missing or unknown token" } });
      assert.ok(!res.text.includes(bogus));
      assert.deepEqual(corsHeaders(res.headers), [], `${label}: no CORS headers`);
    }
    const none = await postJson(relay, PING, { authorization: "" });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="agent-relay"');
    // A valid path token never gets a 401, whatever the method.
    for (const method of ["GET", "HEAD", "DELETE", "OPTIONS"]) {
      const res = await fetch(`${relay.url}/mcp/${relay.tokens.developer}`, { method });
      assert.equal(res.status, 405, `${method} /mcp/<token>`);
    }
  });

  test("JSON-RPC strictness: ids, empty messages, client responses and rejected notifications", async () => {
    for (const id of [null, 1.5, -0.25, true, { n: 1 }]) {
      const res = await postJson(relay, { jsonrpc: "2.0", id, method: "ping" });
      assert.equal(res.status, 400, `id ${JSON.stringify(id)}`);
      assert.equal(res.body.id, null);
      assert.equal(res.body.error.code, -32600);
      assert.equal(res.body.result, undefined);
    }
    for (const id of ["req-1", 0, 42, -7]) {
      const res = await postJson(relay, { jsonrpc: "2.0", id, method: "ping" });
      assert.deepEqual([res.status, res.body], [200, { jsonrpc: "2.0", id, result: {} }], `id ${JSON.stringify(id)}`);
    }
    for (const message of [{ jsonrpc: "2.0" }, {}, { jsonrpc: "2.0", id: 3 }, { jsonrpc: "2.0", id: 3, result: {}, error: { code: 1, message: "x" } }]) {
      const res = await postJson(relay, message);
      assert.equal(res.status, 400, JSON.stringify(message));
      assert.deepEqual([res.body.id, res.body.error.code], [null, -32600]);
    }
    for (const message of [{ jsonrpc: "2.0", id: 9, result: {} }, { jsonrpc: "2.0", id: 9, error: { code: -1, message: "client error" } }]) {
      const res = await postJson(relay, message);
      assert.deepEqual([res.status, res.text], [202, ""], JSON.stringify(message));
    }
    const rejected = await postJson(relay, { jsonrpc: "2.0", method: 42 });
    assert.equal(rejected.status, 400, "a notification the server can't accept is an HTTP error");
    assert.equal(rejected.body.error.code, -32600);
    const accepted = await postJson(relay, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual([accepted.status, accepted.text], [202, ""]);
    const parse = await postJson(relay, "{nope");
    assert.deepEqual([parse.status, parse.body.error.code], [400, -32700]);
  });

  test("batches: allowed up to 20 messages for 2025-03-26 and older (or no header), refused from 2025-06-18", async () => {
    const pings = (n) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "ping" }));
    for (const headers of [{}, { "mcp-protocol-version": "2025-03-26" }, { "mcp-protocol-version": "2024-11-05" }]) {
      const res = await postJson(relay, [...pings(2), { jsonrpc: "2.0", method: "notifications/initialized" }], headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.deepEqual(res.body.map((r) => r.id), [1, 2]);
    }
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const res = await postJson(relay, pings(1), { "mcp-protocol-version": version });
      assert.equal(res.status, 400, version);
      assert.deepEqual(res.body, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Invalid Request: batches are not supported in protocol version ${version}` } });
    }
    const twenty = await postJson(relay, pings(20));
    assert.deepEqual([twenty.status, twenty.body.length], [200, 20]);
    const tooMany = await postJson(relay, pings(21));
    assert.deepEqual([tooMany.status, tooMany.body], [400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: a batch may hold at most 20 messages" } }]);
    const empty = await postJson(relay, []);
    assert.deepEqual([empty.status, empty.body.error.code], [400, -32600]);
    const onlyNotifications = await postJson(relay, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    assert.equal(onlyNotifications.status, 202);
  });

  test("CORS: none on /mcp responses, present on /api and /spike", async () => {
    const mcpResponses = {
      ok: await post(relay, PING, { origin: relay.url }),
      notification: await post(relay, { jsonrpc: "2.0", method: "notifications/initialized" }),
      error: await post(relay, { jsonrpc: "2.0", id: null, method: "ping" }),
      unauthorized: await post(relay, PING, { authorization: "" }),
      options: await fetch(`${relay.url}/mcp`, { method: "OPTIONS" }),
      preflight: await fetch(`${relay.url}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      }),
    };
    assert.deepEqual(
      Object.fromEntries(Object.entries(mcpResponses).map(([name, res]) => [name, res.status])),
      { ok: 200, notification: 202, error: 400, unauthorized: 401, options: 405, preflight: 405 },
    );
    for (const [name, res] of Object.entries(mcpResponses)) assert.deepEqual(corsHeaders(res.headers), [], `/mcp ${name}`);

    for (const path of ["/api/call/send", "/api/inbox", "/spike/events"]) {
      const res = await fetch(`${relay.url}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      assert.equal(res.status, 204, `OPTIONS ${path}`);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      assert.ok(allowed.includes("authorization") && allowed.includes("content-type"), allowed);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    }
    for (const res of [await http(relay, "/api/me", { role: "developer" }), await http(relay, "/api/me"), await http(relay, "/api/nope", { role: "human" })]) {
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
    }
  });

  for (const pathToken of [false, true]) {
    test(`the official MCP SDK client connects with ${pathToken ? "the /mcp/<token> path" : "the Authorization header"}`, async () => {
      for (const role of ROLES) {
        const agent = await connect(relay, role, { pathToken });
        try {
          const { client } = agent;
          assert.deepEqual(client.getServerVersion()?.name, "agent-relay");
          const instructions = client.getInstructions() ?? "";
          assert.equal(instructions, DIGESTS[role], `${role} instructions are protocol/mcp/${role}.md`);
          assert.ok(instructions.length <= 4096, `${role} instructions fit 4,096 chars (${instructions.length})`);
          const { tools } = await client.listTools();
          assert.ok(tools.some((tool) => tool.name === "whoami"));
          assert.equal((await agent.call("whoami")).role, role);
          await client.ping();
        } finally {
          await agent.close();
        }
      }
    });
  }

  test("the role digests name their role (unit test enforces the same)", () => {
    for (const role of ROLES) {
      assert.ok(DIGESTS[role].length <= 4096, `${role}: ${DIGESTS[role].length} chars`);
      assert.ok(DIGESTS[role].toLowerCase().includes(DISPLAY_NAMES[role].toLowerCase()), `${role} digest names "${DISPLAY_NAMES[role]}"`);
    }
  });
});

// =====================================================================================
describe("HUMAN_NAME that collides with `relay`", { concurrency: 1 }, () => {
  let relay;
  before(async () => {
    relay = await startRelay({ vars: { HUMAN_NAME: "Relay" } });
  });
  after(async () => {
    await relay?.stop();
  });

  test("keeps the display name, adds no alias and never resolves `relay` to the human", async () => {
    const me = await relay.call("human", "whoami", {});
    assert.equal(me.result.display_name, "Relay");
    assert.deepEqual(me.result.roles.find((r) => r.id === "human").aliases, ["james"]);
    const build = await relay.call("human", "build_create", { title: "Names", brief: "Check names." });
    assert.equal(build.status, 200, JSON.stringify(build));
    const buildId = build.result.build_id;
    for (const to_role of ["relay", "Relay", " RELAY "]) {
      const res = await relay.call("orchestrator", "send", { build_id: buildId, to_role, type: "question", body: "Who are you?" });
      assert.deepEqual([res.status, res.error?.code], [400, "invalid_input"], `to_role ${JSON.stringify(to_role)}`);
    }
    const toHuman = await relay.call("orchestrator", "send", { build_id: buildId, to_role: "james", type: "question", body: "Colours?" });
    assert.equal(toHuman.result.message.to, "human");
  });
});

// =====================================================================================
// Claude Code as a real client (RUN_LIVE=1). Each run is a one-shot `claude -p` with only the relay
// MCP server (--strict-mcp-config), no user settings, and only the whoami tool allowed.
const LIVE = process.env.RUN_LIVE === "1" ? false : "set RUN_LIVE=1 to run Claude Code against the relay (real claude -p sessions; they cost model tokens)";
const MODEL = process.env.LIVE_MODEL ?? "haiku";
const KEEP = process.env.LIVE_KEEP === "1";

/** The parent may itself be a Claude Code session: its identity must not leak into the children. */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|MESSAGING_|TEE_SDK_STDOUT|DIAGNOSTICS_FILE|CHILD_SESSION|SYNC_SESSION_REFS|POST_FOR_SESSION_INGRESS|CCR_EVENT_FLUSH|REMOTE_SEND_KEEPALIVES|INCLUDE_PARTIAL_MESSAGES)/.test(key) || key === "CLAUDE_PID" || key === "CLAUDECODE") {
      delete env[key];
    }
  }
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
  return env;
}

/**
 * A logging pass-through in front of the relay, so a test can see every request Claude Code makes
 * (method, path with tokens redacted, MCP-Protocol-Version, JSON-RPC method) and the relay's status.
 */
async function startLoggingProxy(relay) {
  const requests = [];
  const redact = (text) => Object.values(relay.tokens).reduce((acc, token) => acc.split(token).join("<token>"), text).replace(/bogus-[A-Za-z0-9_-]+/g, "<bogus>");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let rpcMethod = null;
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      rpcMethod = Array.isArray(parsed) ? "batch" : (parsed.method ?? null);
    } catch {}
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(name)));
    const entry = { method: req.method, path: redact(req.url), version: req.headers["mcp-protocol-version"] ?? null, rpcMethod, status: 0 };
    requests.push(entry);
    try {
      const upstream = await fetch(`${relay.url}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" });
      entry.status = upstream.status;
      const out = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)));
      res.writeHead(upstream.status, { ...outHeaders, "content-length": out.length });
      res.end(out);
    } catch (err) {
      entry.status = 502;
      res.writeHead(502).end(String(err));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs one `claude -p` against `server` (an MCP server config); resolves to its messages, result text and debug log. */
function claudeRun(dir, server, prompt, { timeoutMs = 150_000 } = {}) {
  const sessionId = randomUUID();
  const config = join(dir, `${sessionId}.mcp.json`);
  // The token stays in a 0600 file, not on the command line.
  writeFileSync(config, JSON.stringify({ mcpServers: { relay: server } }));
  chmodSync(config, 0o600);
  const debugFile = join(dir, `${sessionId}.debug.log`);
  const args = [
    "-p", prompt,
    "--mcp-config", config,
    "--strict-mcp-config",
    "--allowedTools", "mcp__relay__whoami",
    "--model", MODEL,
    "--max-turns", "3",
    "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project",
    "--session-id", sessionId,
    "--debug-file", debugFile,
  ];
  const cwd = mkdtempSync(join(dir, "cwd-"));
  const child = spawn("claude", args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(timer);
      const messages = stdout.split("\n").flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line)] : [];
        } catch {
          return [];
        }
      });
      const debug = existsSync(debugFile) ? readFileSync(debugFile, "utf8") : "";
      const result = messages.filter((m) => m.type === "result");
      const toolUses = messages.flatMap((m) => (m.type === "assistant" ? m.message.content.filter((c) => c.type === "tool_use") : []));
      const toolResults = messages.flatMap((m) => (m.type === "user" && Array.isArray(m.message?.content) ? m.message.content : [])).filter((c) => c.type === "tool_result");
      const init = messages.find((m) => m.type === "system" && m.subtype === "init");
      resolve({
        code,
        stderr,
        debug,
        debugFile,
        init,
        text: result.map((r) => r.result ?? "").join("\n"),
        cost: result.reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0),
        toolUses,
        toolResults,
      });
    });
  });
}

const toolResultText = (result) => (typeof result.content === "string" ? result.content : (result.content ?? []).map((c) => c.text ?? "").join(""));
/** Plain lowercase words of three letters or more (markdown and punctuation dropped), for a loose match. */
const plainWords = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 3);
const summarize = (requests) => requests.map((r) => `${r.method} ${r.path} v=${r.version} ${r.rpcMethod ?? ""} -> ${r.status}`).join("\n");

describe("Claude Code as an MCP client (RUN_LIVE=1)", { skip: LIVE, concurrency: 1 }, () => {
  let relay;
  let proxy;
  let dir;
  let spend = 0;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-relay-mcp-spec-live-"));
    relay = await startRelay();
    proxy = await startLoggingProxy(relay);
  });
  after(async () => {
    await proxy?.stop();
    await relay?.stop();
    console.log(`# Claude Code checks: $${spend.toFixed(4)} as reported by claude (${MODEL})${KEEP ? `, logs in ${dir}` : ""}`);
    if (dir && !KEEP) rmSync(dir, { recursive: true, force: true });
  });

  const ask = [
    "Call the mcp__relay__whoami tool exactly once.",
    "Then reply with exactly two lines and nothing else:",
    "ROLE=<the role field of its result>",
    "FIRST=<the first line of the instructions the relay MCP server gave you, copied verbatim>",
  ].join("\n");

  for (const [role, pathToken] of [["developer", false], ["creative-director", true]]) {
    test(`${role} via ${pathToken ? "the /mcp/<token> path" : "the Authorization header"}: whoami works and the instructions arrive whole`, async (t) => {
      proxy.requests.length = 0;
      const server = pathToken
        ? { type: "http", url: `${proxy.url}/mcp/${relay.tokens[role]}` }
        : { type: "http", url: `${proxy.url}/mcp`, headers: { Authorization: `Bearer ${relay.tokens[role]}` } };
      const run = await claudeRun(dir, server, ask);
      spend += run.cost;
      const explain = `exit ${run.code}; text ${JSON.stringify(run.text)}; stderr ${run.stderr.slice(0, 500)}; debug ${run.debugFile}\n${summarize(proxy.requests)}`;
      t.diagnostic(`requests:\n${summarize(proxy.requests)}`);
      t.diagnostic(`answer: ${JSON.stringify(run.text)}`);

      const connected = run.init?.mcp_servers?.find((s) => s.name === "relay");
      assert.equal(connected?.status, "connected", `relay MCP server connected: ${JSON.stringify(run.init?.mcp_servers)}; ${explain}`);
      assert.match(run.debug, /MCP server "relay": Connection established/, explain);
      assert.doesNotMatch(run.debug, /MCP server "relay": Server instructions truncated/, "instructions fit Claude Code's cap");

      // On the wire: any request with an unsupported MCP-Protocol-Version (Claude Code's modern-era
      // probe) got 400, initialize went through, and every later request carried a supported version.
      for (const r of proxy.requests) {
        if (r.version !== null && !SUPPORTED.includes(r.version)) assert.equal(r.status, 400, `unsupported version answered 400:\n${summarize(proxy.requests)}`);
      }
      const init = proxy.requests.find((r) => r.rpcMethod === "initialize");
      assert.equal(init?.status, 200, `initialize answered 200:\n${summarize(proxy.requests)}`);
      const call = proxy.requests.find((r) => r.rpcMethod === "tools/call");
      assert.ok(call && call.status === 200 && SUPPORTED.includes(call.version), `tools/call sent with a supported MCP-Protocol-Version:\n${summarize(proxy.requests)}`);
      assert.ok(!proxy.requests.some((r) => r.status === 401 || r.status === 403), `no 401/403:\n${summarize(proxy.requests)}`);
      // The only 405 is the GET that asks for an SSE stream (the relay is JSON-only, DESIGN §10).
      assert.ok(proxy.requests.every((r) => r.status !== 405 || r.method === "GET"), `405 only for GET:\n${summarize(proxy.requests)}`);

      const whoami = run.toolUses.find((tool) => tool.name === "mcp__relay__whoami");
      assert.ok(whoami, `the model called mcp__relay__whoami; ${explain}`);
      const result = run.toolResults.find((r) => r.tool_use_id === whoami.id);
      assert.ok(result && !result.is_error, `whoami succeeded: ${JSON.stringify(result)}`);
      assert.equal(JSON.parse(toolResultText(result)).role, role);
      assert.match(run.text, new RegExp(`ROLE=\\s*\`?${role}`), explain);

      // The model can quote the digest's first line, so the instructions reached it.
      const firstLine = DIGESTS[role].split("\n").find((line) => line.trim() !== "") ?? "";
      const quoted = run.text.split("\n").find((line) => line.includes("FIRST=")) ?? "";
      const expected = plainWords(firstLine);
      const got = new Set(plainWords(quoted));
      const hits = expected.filter((w) => got.has(w)).length;
      assert.ok(expected.length > 0 && hits / expected.length >= 0.6, `the model quoted the digest's first line ${JSON.stringify(firstLine)}; got ${JSON.stringify(quoted)}`);
    });
  }

  for (const pathToken of [false, true]) {
    test(`a wrong ${pathToken ? "path" : "header"} token ends in a 401 or 404, never 405, and leaks no token`, async (t) => {
      proxy.requests.length = 0;
      const bogus = `bogus-${randomBytes(24).toString("base64url")}`;
      const server = pathToken
        ? { type: "http", url: `${proxy.url}/mcp/${bogus}` }
        : { type: "http", url: `${proxy.url}/mcp`, headers: { Authorization: `Bearer ${bogus}` } };
      const run = await claudeRun(dir, server, "Reply with exactly OK.");
      spend += run.cost;
      t.diagnostic(`requests:\n${summarize(proxy.requests)}`);
      const relayServer = run.init?.mcp_servers?.find((s) => s.name === "relay");
      assert.notEqual(relayServer?.status, "connected", JSON.stringify(run.init?.mcp_servers));
      assert.ok(proxy.requests.some((r) => r.path.startsWith("/mcp") && r.status === 401), `the relay answered 401:\n${summarize(proxy.requests)}`);
      // OAuth discovery and registration probes (path form) find nothing: 404, not 401 or 405.
      for (const r of proxy.requests.filter((r) => !r.path.startsWith("/mcp"))) {
        assert.equal(r.status, 404, `${r.method} ${r.path}:\n${summarize(proxy.requests)}`);
      }
      assert.ok(!proxy.requests.some((r) => r.status === 405), summarize(proxy.requests));
      const failures = run.debug.split("\n").filter((line) => /MCP server "relay"/.test(line) && /(fail|error|HTTP \d{3})/i.test(line));
      t.diagnostic(`Claude Code reported:\n${failures.map((l) => l.slice(0, 300)).join("\n")}`);
      assert.ok(failures.length > 0, `the debug log reports the failed connection (${run.debugFile})`);
      assert.ok(!failures.some((line) => /HTTP 405/.test(line)), `no 405 in: ${failures.join("\n")}`);
      assert.ok(!run.debug.includes(bogus), "the token never reaches the debug log");
    });
  }
});
