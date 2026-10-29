// Helpers for test/e2e/relay.test.mjs: one official MCP SDK client per role, raw
// HTTP / JSON-RPC access, polling and the inbox / ledger assertions the suite repeats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROLES } from "./harness.mjs";

export { ROLES };

export const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const BUILD_ID = /^b-[a-z2-7]{10}$/;

/** One MCP client acting as one role. */
export class Agent {
  constructor(role, client, auth) {
    this.role = role;
    this.client = client;
    this.auth = auth;
  }

  /** Calls a tool; returns {ok, result} or {ok: false, code, message, text}. */
  async tryCall(tool, args = {}) {
    const res = await this.client.callTool({ name: tool, arguments: args });
    if (res.isError) {
      assert.equal(res.content?.length, 1, `${tool}: an error result has one text block`);
      assert.equal(res.content[0].type, "text");
      const text = res.content[0].text;
      const match = /^([a-z_]+): ([\s\S]*)$/.exec(text);
      assert.ok(match, `${tool}: error text should read "<code>: <message>", got ${JSON.stringify(text)}`);
      return { ok: false, code: match[1], message: match[2], text };
    }
    // DESIGN §10: {content: [{type: "text", text: <JSON of result>}], structuredContent: <result>}
    assert.equal(res.content?.[0]?.type, "text", `${tool}: result has a text block`);
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent, `${tool}: text block is the JSON of structuredContent`);
    return { ok: true, result: res.structuredContent };
  }

  async call(tool, args = {}) {
    const res = await this.tryCall(tool, args);
    if (!res.ok) throw new assert.AssertionError({ message: `${this.role} ${tool} failed: ${res.text}`, actual: res.text, expected: "success" });
    return res.result;
  }

  /** Expects the call to fail with `code`; returns the parsed error. */
  async fails(tool, args, code) {
    const res = await this.tryCall(tool, args);
    assert.equal(res.ok, false, `${this.role} ${tool} should fail with ${code} but succeeded: ${JSON.stringify(res.result)?.slice(0, 300)}`);
    assert.equal(res.code, code, `${this.role} ${tool}: expected ${code}, got ${res.text}`);
    return res;
  }

  /** Expects the call to fail with one of `codes`. */
  async failsAny(tool, args, codes) {
    const res = await this.tryCall(tool, args);
    assert.equal(res.ok, false, `${this.role} ${tool} should fail (${codes.join("|")}) but succeeded`);
    assert.ok(codes.includes(res.code), `${this.role} ${tool}: expected ${codes.join("|")}, got ${res.text}`);
    return res;
  }

  close() {
    return this.client.close().catch(() => {});
  }
}

/** Connects `role` over MCP, with the token in the Authorization header or in the /mcp/<token> path. */
export async function connect(relay, role, { pathToken = false, token } = {}) {
  const value = token ?? relay.tokens[role];
  const url = pathToken ? `${relay.url}/mcp/${encodeURIComponent(value)}` : `${relay.url}/mcp`;
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    pathToken ? {} : { requestInit: { headers: { Authorization: `Bearer ${value}` } } },
  );
  const client = new Client({ name: `e2e-${role}`, version: "1.0.0" });
  await client.connect(transport);
  return new Agent(role, client, pathToken ? "path" : "header");
}

/** One Agent per role; roles listed in `pathRoles` authenticate with the path form. */
export async function connectTeam(relay, { pathRoles = [] } = {}) {
  const entries = await Promise.all(
    ROLES.map(async (role) => [role, await connect(relay, role, { pathToken: pathRoles.includes(role) })]),
  );
  return Object.fromEntries(entries);
}

export async function closeTeam(team) {
  if (team) await Promise.all(Object.values(team).map((agent) => agent.close()));
}

/** Raw HTTP against the relay. Returns {status, headers, body (parsed JSON or text or null)}. */
export async function http(relay, path, { method = "GET", role, token, headers = {}, body, rawBody } = {}) {
  const h = { ...headers };
  const bearer = token ?? (role ? relay.tokens[role] : undefined);
  if (bearer !== undefined) h.authorization = `Bearer ${bearer}`;
  let payload = rawBody;
  if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${relay.url}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** POSTs one raw JSON-RPC payload to /mcp (header auth) or /mcp/<token>. */
export function rpc(relay, payload, { role = "human", token, pathToken = false, headers = {} } = {}) {
  const value = token ?? relay.tokens[role];
  const accept = { accept: "application/json, text/event-stream", ...headers };
  if (pathToken) return http(relay, `/mcp/${encodeURIComponent(value)}`, { method: "POST", headers: accept, body: payload });
  return http(relay, "/mcp", { method: "POST", token: value, headers: accept, body: payload });
}

/** Polls fn until it returns a truthy value; throws with `message` after `timeout` ms. */
export async function waitFor(fn, { timeout = 15_000, interval = 150, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out after ${timeout} ms waiting for ${message}` });
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sequential steps sharing state: once a step fails, the later ones are skipped
 * (they would only fail for the same reason).
 */
export function stepper() {
  let failed = null;
  return (name, fn) =>
    test(name, async (t) => {
      if (failed) {
        t.skip(`earlier step failed: ${failed}`);
        return;
      }
      try {
        await fn(t);
      } catch (err) {
        failed = name;
        throw err;
      }
    });
}

/** The one inbox entry for buildId from an inbox result. */
export function entryFor(inbox, buildId) {
  const entry = inbox.builds.find((b) => b.build_id === buildId);
  assert.ok(entry, `inbox has an entry for ${buildId}: ${JSON.stringify(inbox.builds.map((b) => b.build_id))}`);
  return entry;
}

/**
 * Delivery check for one recipient: a peek shows exactly the expected unread messages
 * (and has no side effects), a normal read returns the same messages and marks them read,
 * and a second peek shows nothing left. Returns the messages as read.
 */
export async function deliver(agent, buildId, expected, { sessionRef } = {}) {
  const peek = entryFor(await agent.call("inbox", { build_id: buildId, peek: true }), buildId);
  assert.deepEqual(
    peek.messages.map((m, i) => `${m.from}->${m.to}${expected[i]?.type ? `:${m.type}` : ""}`),
    expected.map((e) => `${e.from}->${agent.role}${e.type ? `:${e.type}` : ""}`),
    `${agent.role} unread messages (peek)`,
  );
  for (const m of peek.messages) {
    assert.equal(m.read_at, null, `${m.id} is unread in the peek`);
    assert.equal(m.to, agent.role);
    assert.equal(m.build_id, buildId);
    assert.equal(m.id, `M${m.seq}`);
    assert.match(m.created_at, ISO);
  }
  assert.equal(peek.unread_remaining, 0, "everything unread was returned");
  const again = entryFor(await agent.call("inbox", { build_id: buildId, peek: true }), buildId);
  assert.deepEqual(again.messages.map((m) => m.id), peek.messages.map((m) => m.id), "a peek marks nothing read");

  const read = entryFor(
    await agent.call("inbox", { build_id: buildId, ...(sessionRef ? { session_ref: sessionRef } : {}) }),
    buildId,
  );
  assert.deepEqual(read.messages.map((m) => m.id), peek.messages.map((m) => m.id), "a read returns the unread messages");
  for (const m of read.messages) assert.match(m.read_at ?? "", ISO, `${m.id} carries read_at once read`);
  assert.equal(read.unread_remaining, 0);
  assert.equal(read.thread_key, `${buildId}/${agent.role}`);
  if (read.messages.length > 0) assert.equal(read.cursor, read.messages.at(-1).seq, "cursor is the last returned seq");

  const after = entryFor(await agent.call("inbox", { build_id: buildId, peek: true }), buildId);
  assert.equal(after.messages.length, 0, `${agent.role} has nothing unread after reading`);

  expected.forEach((e, i) => {
    const m = read.messages[i];
    for (const [key, value] of Object.entries(e)) {
      if (value instanceof RegExp) assert.match(String(m[key]), value, `${m.id}.${key}`);
      else assert.deepEqual(m[key], value, `${m.id}.${key}`);
    }
  });
  return { messages: read.messages, entry: read };
}

/** Asserts none of `agents` has unread messages in buildId (peek only, no side effects). */
export async function assertNoUnread(agents, buildId) {
  for (const agent of agents) {
    const entry = entryFor(await agent.call("inbox", { build_id: buildId, peek: true }), buildId);
    assert.deepEqual(
      entry.messages.map((m) => `${m.id} ${m.from}->${m.to}:${m.type}`),
      [],
      `${agent.role} should have no unread messages`,
    );
  }
}

export function taskIn(ledger, id) {
  const task = ledger.tasks.find((t) => t.id === id);
  assert.ok(task, `ledger has task ${id}`);
  return task;
}

/** Checks a subset of fields of an object (RegExp values are matched against String(value)). */
export function assertFields(actual, expected, label = "object") {
  assert.ok(actual, `${label} exists`);
  for (const [key, value] of Object.entries(expected)) {
    if (value instanceof RegExp) assert.match(String(actual[key]), value, `${label}.${key}`);
    else assert.deepEqual(actual[key], value, `${label}.${key}`);
  }
}

/** Tracks audit rows across steps: `next(ledger)` returns the rows added since the last call. */
export function auditCursor() {
  let lastSeq = 0;
  return (ledger) => {
    const rows = ledger.audit.filter((row) => row.seq > lastSeq);
    for (const row of rows) {
      assert.match(row.at, ISO, `audit ${row.seq} at`);
      assert.ok(row.seq > lastSeq, "audit seq increases");
      lastSeq = row.seq;
    }
    return rows;
  };
}

/** Asserts every expected [actor, actionRegExp, target] appears among rows. */
export function assertAudit(rows, expected) {
  for (const [actor, action, target] of expected) {
    const hit = rows.find((row) => row.actor === actor && action.test(row.action) && row.target === target);
    assert.ok(
      hit,
      `audit row {actor: ${actor}, action: ${action}, target: ${target}} missing; got ${JSON.stringify(
        rows.map((r) => [r.actor, r.action, r.target]),
      )}`,
    );
  }
}

/** Replaces volatile fields (ids, timestamps, seq) so two equivalent results compare equal. */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && ISO.test(item)) out[key] = "<time>";
      else if (["id", "seq", "message_id", "cursor"].includes(key)) out[key] = "<id>";
      else out[key] = normalize(item);
    }
    return out;
  }
  return value;
}
