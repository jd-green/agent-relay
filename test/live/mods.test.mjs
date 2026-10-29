// Live end-to-end checks of the two Mods (mods/relay-spike, mods/relay-inbox) with real
// `claude -p` sessions against a real relay started by test/e2e/harness.mjs.
//
//   RUN_LIVE=1 NO_PROXY=127.0.0.1,localhost node --test test/live/mods.test.mjs
//
// Skipped unless RUN_LIVE=1: every test that prompts the model costs tokens (haiku by default,
// LIVE_MODEL=<alias> to change). See test/live/README.md for what it checks and what it costs.
//
// Nothing is installed: each session loads a Mod from its folder with --plugin-dir, gets the Mod's
// options through --settings '{"pluginConfigs": {...}}', reads no user/local settings
// (--setting-sources project, from an empty temp working directory) and only the MCP servers given
// here (--strict-mcp-config).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRelay } from "../e2e/harness.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = process.env.LIVE_MODEL ?? "haiku";
const KEEP = process.env.LIVE_KEEP === "1";
const SKIP = process.env.RUN_LIVE === "1" ? false : "set RUN_LIVE=1 to run the live Mod tests (real claude -p sessions; they cost model tokens)";

const nonce = (prefix) => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
/** The fingerprint relay-spike records for a value: its SHA-256 prefix and length, never the text. */
const fingerprint = (text) => ({ sha256: createHash("sha256").update(text).digest("hex").slice(0, 16), length: text.length });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- temp files and children

const temps = [];
const children = new Set();
const spend = { sessions: 0, usd: 0 };
let logDir;
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
function logs() {
  logDir ??= tempDir("agent-relay-mods-live-");
  return logDir;
}
process.on("exit", () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  if (!KEEP) for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** The parent may itself be a Claude Code session: its identity must not leak into the children. */
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|MESSAGING_|TEE_SDK_STDOUT|DIAGNOSTICS_FILE|CHILD_SESSION|SYNC_SESSION_REFS|POST_FOR_SESSION_INGRESS|CCR_EVENT_FLUSH|REMOTE_SEND_KEEPALIVES|INCLUDE_PARTIAL_MESSAGES)/.test(key) ||
      key === "CLAUDE_PID" ||
      key === "CLAUDECODE"
    ) {
      delete env[key];
    }
  }
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
  return env;
}

// --------------------------------------------------------------------------- one claude session

/**
 * Starts `claude -p` with the given Mods. `prompt` makes a one-shot run; `stdin: true` keeps the session
 * alive (--input-format stream-json, the way the SDK and the desktop app host a session) until `end()`.
 * Output is stream-json, so every turn's result, tool call and Mod status line is kept.
 */
function claude({ prompt, stdin = false, plugins = {}, mcp, allowedTools = [], maxTurns = 3, timeoutMs = 150_000, cwd, sessionId = randomUUID() }) {
  const work = cwd ?? tempDir("agent-relay-mods-cwd-");
  const debugFile = join(logs(), `${sessionId}.debug.log`);
  const settings = { pluginConfigs: Object.fromEntries(Object.entries(plugins).map(([name, options]) => [name, { options }])) };
  const args = ["-p", ...(stdin ? ["--input-format", "stream-json"] : [prompt])];
  args.push("--output-format", "stream-json", "--verbose", "--model", MODEL, "--max-turns", String(maxTurns));
  args.push("--session-id", sessionId, "--debug-file", debugFile, "--settings", JSON.stringify(settings));
  args.push("--setting-sources", "project", "--strict-mcp-config");
  for (const name of Object.keys(plugins)) args.push("--plugin-dir", join(REPO, "mods", name));
  if (mcp) {
    const file = join(logs(), `${sessionId}.mcp.json`);
    const server = { type: "http", url: mcp.relay.mcpUrl(mcp.role), headers: { Authorization: `Bearer ${mcp.relay.tokens[mcp.role]}` } };
    writeFileSync(file, JSON.stringify({ mcpServers: { relay: server } }));
    args.push("--mcp-config", file);
    allowedTools = [...allowedTools, "mcp__relay__*"];
  }
  if (allowedTools.length) args.push("--allowedTools", allowedTools.join(" "));

  const started = Date.now();
  const child = spawn("claude", args, { cwd: work, env: childEnv(), stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
  children.add(child);
  const run = { sessionId, debugFile, cwd: work, messages: [], results: [], statuses: [], stderr: "", code: null, ms: 0, started };
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      message._at = Date.now() - started;
      run.messages.push(message);
      if (message.type === "result") run.results.push(message);
      if (message.type === "system" && message.subtype === "ui_status") run.statuses.push({ plugin: message.plugin, text: message.text, at: message._at });
    }
  });
  child.stderr.on("data", (chunk) => (run.stderr += chunk));
  const timer = setTimeout(() => {
    run.timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);
  run.exited = new Promise((resolve) =>
    child.on("exit", (code) => {
      clearTimeout(timer);
      children.delete(child);
      run.code = code;
      run.ms = Date.now() - started;
      spend.sessions += 1;
      spend.usd += cost(run);
      resolve(run);
    }),
  );
  run.send = (text) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  run.end = () => child.stdin?.end();
  /** Resolves true once `predicate(run)` holds, false at the deadline or when the session exits first. */
  run.until = async (predicate, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate(run)) return true;
      if (run.code !== null) return predicate(run);
      await sleep(200);
    }
    return predicate(run);
  };
  run.text = () => run.results.map((r) => r.result ?? "").join("\n");
  run.tools = () => run.messages.flatMap((m) => (m.type === "assistant" ? m.message.content.filter((c) => c.type === "tool_use") : []));
  run.toolResult = (id) =>
    run.messages.flatMap((m) => (m.type === "user" && Array.isArray(m.message?.content) ? m.message.content : [])).find((c) => c.type === "tool_result" && c.tool_use_id === id);
  run.statusTexts = (plugin) => run.statuses.filter((s) => !plugin || s.plugin === plugin).map((s) => s.text);
  return run;
}

/** What to print when a run did not do what a test expected. */
function explain(run) {
  const loadLines = existsSync(run.debugFile)
    ? readFileSync(run.debugFile, "utf8").split("\n").filter((l) => /hooks module relay-|plugin\.register: relay-|relay-(spike|inbox): /.test(l)).slice(0, 12)
    : [];
  return [
    `exit ${run.code}${run.timedOut ? " (timed out)" : ""} after ${run.ms} ms, session ${run.sessionId}`,
    `results: ${JSON.stringify(run.results.map((r) => r.result))}`,
    `statuses: ${JSON.stringify(run.statusTexts())}`,
    `stderr: ${run.stderr.slice(0, 800)}`,
    `debug log (${run.debugFile}):`,
    ...loadLines,
  ].join("\n");
}

const cost = (run) => run.results.reduce((sum, r) => sum + (r.total_cost_usd ?? 0), 0);

after(() => {
  if (!SKIP) console.log(`# live Mod checks: ${spend.sessions} claude sessions, $${spend.usd.toFixed(4)} as reported by claude (${MODEL})${KEEP ? `, logs in ${logDir}` : ""}`);
});

// --------------------------------------------------------------------------- relay helpers

async function waitFor(fn, ms = 10_000, every = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(every);
  }
}

async function asHuman(relay, path, init = {}) {
  const res = await fetch(`${relay.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${relay.tokens.human}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, ...(await res.json()) };
}

/** Spike events of one session, oldest first. */
async function spikeEvents(relay, sessionId) {
  const reply = await asHuman(relay, "/spike/events?limit=1000");
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result.events.filter((e) => e.session_id === sessionId).reverse();
}

/** Waits until the session's records include `session.end` (the Mod flushes at exit within ~1.5 s). */
async function spikeEventsAfterEnd(relay, sessionId) {
  let events = [];
  await waitFor(async () => {
    events = await spikeEvents(relay, sessionId);
    return events.some((e) => e.event === "session.end");
  }, 10_000);
  return events;
}

const spikeOptions = (relay, role = "developer", extra = {}) => ({ relay_url: relay.url, role_token: relay.tokens[role], poll_seconds: 15, ...extra });
const inboxOptions = (relay, role = "developer", extra = {}) => ({ relay_url: relay.url, role_token: relay.tokens[role], poll_seconds: 15, auto_wake: true, ...extra });

async function ok(promise) {
  const reply = await promise;
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}

/** A port nothing listens on. */
function deadPort() {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** An HTTP server that accepts every request and never answers. */
async function hangingServer() {
  const sockets = new Set();
  const server = createServer(() => {});
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

/**
 * A relay in front of the real one that answers some requests late: the request reaches the relay at
 * once (a read marks mail read, a wake poll consumes its wakes), and only the answer is held back.
 * `slow(method, path, body)` returns how many ms to hold the answer of that request.
 */
async function slowProxy(target, slow) {
  const sockets = new Set();
  const held = [];
  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    try {
      const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
      const text = await upstream.text();
      const ms = slow(req.method, req.url.split("?")[0], body);
      if (ms > 0) {
        held.push({ method: req.method, path: req.url, ms });
        await sleep(ms);
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "bad_gateway", message: String(error) } }));
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    held,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

/** Holds the answer of every inbox read that marks mail read (`POST /api/call/inbox` with `peek: false`) for `ms`. */
const slowReads = (ms) => (method, path, body) => {
  if (method !== "POST" || path !== "/api/call/inbox") return 0;
  try {
    return JSON.parse(body).peek === false ? ms : 0;
  } catch {
    return 0;
  }
};

// =========================================================================== relay-spike

describe("relay-spike Mod against a live relay", { skip: SKIP }, () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(async () => {
    await relay?.stop();
  });

  test("posts hook events (no prompt text, file contents or token) and its marker reaches the model", { timeout: 180_000 }, async (t) => {
    const work = tempDir("agent-relay-mods-cwd-");
    const fileSecret = nonce("FILESECRET");
    const promptSecret = nonce("PROMPTSECRET");
    writeFileSync(join(work, "notes.txt"), `${fileSecret} the quick brown fox\n`);
    const run = await claude({
      cwd: work,
      plugins: { "relay-spike": spikeOptions(relay) },
      allowedTools: ["Read"],
      maxTurns: 4,
      prompt:
        `${promptSecret} is a label; ignore it. First read the file notes.txt with the Read tool. Then answer on one line, exactly: ` +
        'MARKER=<the 8-character value after "relay-spike marker:" in your context, or none> WORD=<the first word of the file>',
    }).exited;
    assert.equal(run.code, 0, explain(run));

    const events = await spikeEventsAfterEnd(relay, run.sessionId);
    const names = events.map((e) => e.event);
    t.diagnostic(`events: ${names.join(", ")}`);
    for (const name of ["session.start", "prompt.submit", "turn.start", "context.injected", "tool.call", "turn.complete", "session.end"]) {
      assert.ok(names.includes(name), `no ${name} record; got ${names.join(", ")}\n${explain(run)}`);
    }
    assert.deepEqual(events.filter((e) => e.event === "tool.call").map((e) => e.detail.tool), ["Read"]);
    assert.ok(events.every((e) => e.role === "developer"), "every record carries the token's role");

    const start = events.find((e) => e.event === "session.start");
    const marker = start.detail.nonce;
    // Derived from the session id, so a reload of the Mod keeps it.
    assert.equal(marker, createHash("sha256").update(`relay-spike marker:${run.sessionId}`).digest("hex").slice(0, 8));
    assert.equal(events.find((e) => e.event === "context.injected").detail.nonce, marker);
    // Which context blocks the conversation carries, with fingerprints (never the text) of the Project block and the directory.
    const cwd = fingerprint(realpathSync(work));
    assert.deepEqual(start.detail.cwd, cwd, "session.start fingerprints the directory");
    const context = events.find((e) => e.event === "prompt.context");
    assert.ok(context, `no prompt.context record; got ${names.join(", ")}`);
    assert.ok(Array.isArray(context.detail.blocks) && context.detail.blocks.every((name) => typeof name === "string"), JSON.stringify(context.detail));
    assert.ok(!context.detail.blocks.includes("attachedProject"), "a terminal session has no attached Project");
    assert.deepEqual([context.detail.attached_project, context.detail.cwd], [null, cwd]);
    assert.match(run.text(), new RegExp(`MARKER=${marker}`), `the model did not quote the marker ${marker}\n${explain(run)}`);
    assert.match(run.text(), new RegExp(`WORD=${fileSecret}`), "the Read tool really ran");

    const raw = JSON.stringify(events);
    for (const secret of [promptSecret, fileSecret, "quick brown", "notes.txt", relay.tokens.developer, "Read the file", work]) {
      assert.ok(!raw.includes(secret), `a spike record carries ${JSON.stringify(secret)}`);
    }
    t.diagnostic(`session.start detail: ${JSON.stringify(start.detail)} · cost $${cost(run).toFixed(4)}`);
  });

  test("a wake queued for a session before it starts is consumed and runs as a second turn", { timeout: 180_000 }, async (t) => {
    const sessionId = randomUUID();
    const word = nonce("WAKE");
    const queued = await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ role: "developer", session_id: sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` }) }));
    const run = await claude({ sessionId, plugins: { "relay-spike": spikeOptions(relay) }, prompt: "Reply with exactly FIRST-OK and nothing else." }).exited;
    assert.equal(run.code, 0, explain(run));

    const events = await spikeEventsAfterEnd(relay, sessionId);
    const names = events.map((e) => e.event);
    t.diagnostic(`events: ${names.join(", ")}; results: ${JSON.stringify(run.results.map((r) => r.result))}`);
    assert.ok(names.includes("wake.submitted"), names.join(", "));
    assert.equal(events.find((e) => e.event === "wake.submitted").detail.wake_id, queued.wake.id);
    assert.ok(names.includes("wake.turn_started"), `the wake's turn did not start: ${names.join(", ")}`);
    assert.equal(names.filter((n) => n === "turn.start").length, 2, "the -p prompt's turn and the wake's turn");
    assert.match(run.text(), new RegExp(word), `the wake turn's answer is missing\n${explain(run)}`);
    // Consumed: nothing is left for that session.
    const left = await (await fetch(`${relay.url}/spike/wake?session_id=${sessionId}`, { headers: { authorization: `Bearer ${relay.tokens.developer}` } })).json();
    assert.deepEqual(left.result.wakes, []);
  });

  test("an idle long-lived headless session is woken by a wake queued while it waits", { timeout: 180_000 }, async (t) => {
    const word = nonce("IDLEWAKE");
    const session = claude({ stdin: true, plugins: { "relay-spike": spikeOptions(relay) } });
    try {
      session.send("Reply with exactly READY and nothing else.");
      assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
      const queuedAt = Date.now();
      await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ role: "developer", session_id: session.sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` }) }));
      // poll_seconds 15 (the minimum): the wake is picked up within one poll and one 5 s tick.
      assert.ok(await session.until((r) => r.results.length >= 2, 60_000), `no turn started by itself\n${explain(session)}`);
      t.diagnostic(`wake started a turn ${((Date.now() - queuedAt) / 1000).toFixed(1)} s after it was queued`);
      assert.match(session.results[1].result, new RegExp(word));
    } finally {
      session.end();
      await session.exited;
    }
    const names = (await spikeEventsAfterEnd(relay, session.sessionId)).map((e) => e.event);
    assert.ok(names.includes("wake.submitted") && names.includes("wake.turn_started"), names.join(", "));
  });

  test("a wake poll the relay answers slowly (5 s, past the 3 s other requests wait) still starts a turn", { timeout: 180_000 }, async (t) => {
    const word = nonce("SLOWWAKE");
    const proxy = await slowProxy(relay.url, (method, path) => (method === "GET" && path === "/spike/wake" ? 5_000 : 0));
    const session = claude({ stdin: true, plugins: { "relay-spike": spikeOptions(relay, "developer", { relay_url: proxy.url }) } });
    try {
      session.send("Reply with exactly READY and nothing else.");
      assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
      await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ role: "developer", session_id: session.sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` }) }));
      assert.ok(await session.until((r) => r.results.length >= 2, 60_000), `no turn started by itself\n${explain(session)}`);
      assert.match(session.results[1].result, new RegExp(word));
    } finally {
      session.end();
      await session.exited;
      await proxy.close();
    }
    const events = await spikeEventsAfterEnd(relay, session.sessionId);
    const wakes = events.filter((e) => e.event.startsWith("wake.")).map((e) => e.event);
    t.diagnostic(`wake records: ${wakes.join(", ")} · answers held: ${proxy.held.length}`);
    assert.ok(proxy.held.length >= 2, "the wake polls went through the slow proxy");
    assert.deepEqual(wakes, ["wake.submitted", "wake.turn_started"], "submitted from the slow answer itself, not given up on");
  });

  test("a wake that arrives while a turn runs is deferred, then submitted once the turn is over", { timeout: 180_000 }, async (t) => {
    const sessionId = randomUUID();
    const word = nonce("DEFERRED");
    const session = claude({
      sessionId,
      plugins: { "relay-spike": spikeOptions(relay) },
      allowedTools: ["Bash(node -e:*)"],
      maxTurns: 4,
      prompt: 'Run exactly this shell command with the Bash tool, in the foreground: node -e "setTimeout(() => console.log(1), 25000)" -- then reply with exactly SLEPT.',
    });
    let wakeId;
    const queued = waitFor(async () => {
      if (session.code !== null) return true;
      const events = await spikeEvents(relay, sessionId);
      if (!events.some((e) => e.event === "tool.call")) return false;
      const body = { role: "developer", session_id: sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` };
      wakeId = (await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify(body) }))).wake.id;
      return true;
    }, 60_000, 500);
    const run = await session.exited;
    await queued;
    assert.equal(run.code, 0, explain(run));
    assert.ok(wakeId, `the turn never called a tool, so no wake was queued\n${explain(run)}`);
    const events = await spikeEventsAfterEnd(relay, sessionId);
    const names = events.map((e) => e.event);
    t.diagnostic(`events: ${events.map((e) => `${e.ts.slice(11, 19)} ${e.event}`).join(", ")}; results: ${JSON.stringify(run.results.map((r) => r.result))}`);
    const wakes = events.filter((e) => e.event.startsWith("wake.")).map((e) => [e.event, e.detail.wake_id]);
    assert.deepEqual(wakes, [["wake.deferred", wakeId], ["wake.submitted", wakeId], ["wake.turn_started", wakeId]], names.join(", "));
    const deferredAt = events.findIndex((e) => e.event === "wake.deferred");
    const submittedAt = events.findIndex((e) => e.event === "wake.submitted");
    assert.ok(names.slice(deferredAt, submittedAt).includes("turn.complete"), "submitted only after the busy turn completed");
    assert.equal(names.filter((n) => n === "turn.start").length, 2, "the busy turn, then the wake's turn");
    assert.match(run.text(), new RegExp(word), `the deferred wake's turn did not answer\n${explain(run)}`);
  });

  test("relay down: the turn completes normally and /relay-spike reports the relay unreachable", { timeout: 180_000 }, async () => {
    const url = `http://127.0.0.1:${await deadPort()}`;
    const options = { relay_url: url, role_token: relay.tokens.developer, poll_seconds: 15 };
    const run = await claude({ plugins: { "relay-spike": options }, prompt: "Reply with exactly OK-DOWN and nothing else." }).exited;
    assert.equal(run.code, 0, explain(run));
    assert.match(run.text(), /OK-DOWN/);
    assert.equal(run.results.at(-1).is_error, false);

    const report = await claude({ plugins: { "relay-spike": options }, prompt: "/relay-spike" }).exited;
    assert.equal(report.code, 0, explain(report));
    assert.match(report.text(), /relay: unreachable/, explain(report));
    assert.match(report.text(), /last error: .*(ECONNREFUSED|unreachable)/);
    assert.match(report.text(), /events: 0 sent, \d+ queued/);
  });

  test("rejected token: the turn completes and /relay-spike says the token was rejected", { timeout: 120_000 }, async () => {
    const options = { relay_url: relay.url, role_token: `bad-${randomBytes(20).toString("hex")}`, poll_seconds: 15 };
    const report = await claude({ plugins: { "relay-spike": options }, prompt: "/relay-spike" }).exited;
    assert.equal(report.code, 0, explain(report));
    assert.match(report.text(), /relay: reachable · token: rejected \(401\)/, explain(report));
    assert.deepEqual(await spikeEvents(relay, report.sessionId), [], "the relay stored nothing for a bad token");
  });
});

// =========================================================================== relay-inbox

describe("relay-inbox Mod against a live relay", { skip: SKIP }, () => {
  let relay;
  let buildId;
  before(async () => {
    relay = await startRelay();
    buildId = (await ok(relay.call("human", "build_create", { title: "Live Mod check", brief: "Exercise the inbox Mod." }))).build_id;
  });
  after(async () => {
    await relay?.stop();
  });

  /** A message to the developer; `question` is accepted while the build is in `planning`. */
  const tell = async (body, from = "orchestrator", to = "developer") =>
    (await ok(relay.call(from, "send", { build_id: buildId, to_role: to, type: "question", body }))).message;
  /** Marks everything the developer has unread, so each test starts from an empty inbox. */
  const drain = (role = "developer") => ok(relay.call(role, "inbox", { peek: false, limit: 100 }));
  const message = async (id) => (await ok(relay.call("human", "ledger_get", { build_id: buildId }))).messages.find((m) => m.id === id);
  const inboxOf = async (role) => (await ok(relay.call(role, "inbox", { build_id: buildId, since: 0, peek: true, limit: 100 }))).builds[0].messages;

  test("the next prompt carries the unread messages, and exactly those are marked read on the relay", { timeout: 180_000 }, async (t) => {
    await drain();
    const words = [nonce("INBOX"), nonce("INBOX")];
    const sent = [];
    for (const word of words) sent.push(await tell(`Live check: the codeword is ${word}. Please confirm you can see it.`));
    const unreadBefore = (await ok(relay.call("human", "ledger_get", { build_id: buildId }))).messages.filter((m) => m.to === "developer" && m.read_at === null).map((m) => m.id);
    assert.deepEqual(unreadBefore, sent.map((m) => m.id));
    const run = await claude({
      plugins: { "relay-inbox": inboxOptions(relay) },
      prompt:
        "List the codewords of every Agent Relay inbox message in your context, oldest first: reply with exactly " +
        "CODEWORDS=<codewords, comma-separated> or CODEWORDS=none. Do not use tools.",
    }).exited;
    assert.equal(run.code, 0, explain(run));
    t.diagnostic(`statuses: ${JSON.stringify(run.statusTexts("relay-inbox"))} · answer: ${run.text()}`);
    assert.match(run.text(), new RegExp(`CODEWORDS=${words[0]}, ?${words[1]}`), explain(run));
    // The read state matches what the model was handed: the run marked read exactly the two messages it quoted.
    const ledger = await ok(relay.call("human", "ledger_get", { build_id: buildId }));
    const markedByRun = ledger.messages.filter((m) => unreadBefore.includes(m.id) && m.read_at !== null).map((m) => m.id);
    assert.deepEqual(markedByRun, sent.map((m) => m.id));
    assert.deepEqual(ledger.messages.filter((m) => m.to === "developer" && m.read_at === null).map((m) => m.id), [], "nothing left unread");
    assert.ok(run.statusTexts("relay-inbox").some((s) => /^Relay · 2 unread · b-/.test(s)), "the status line counted the unread messages");
    const thread = ledger.threads.find((th) => th.role === "developer");
    assert.equal(thread.session_ref, run.sessionId, "the poll recorded the session as the developer's presence");
  });

  test("with the relay MCP server too: the message is injected once and the inbox tool does not list it again", { timeout: 180_000 }, async () => {
    await drain();
    const word = nonce("MCP");
    const sent = await tell(`MCP check: the codeword is ${word}.`);
    const run = await claude({
      plugins: { "relay-inbox": inboxOptions(relay) },
      mcp: { relay, role: "developer" },
      maxTurns: 5,
      prompt:
        "What codeword did the orchestrator send you over the relay? Then call the relay inbox tool (mcp__relay__inbox) once with no arguments. " +
        "Reply as: CODEWORD=<codeword> INBOX_COUNT=<number of messages it returned>.",
    }).exited;
    assert.equal(run.code, 0, explain(run));
    assert.match(run.text(), new RegExp(`CODEWORD=${word}`), explain(run));
    const call = run.tools().find((c) => c.name === "mcp__relay__inbox");
    assert.ok(call, `the model did not call the inbox tool\n${explain(run)}`);
    const result = run.toolResult(call.id);
    const text = typeof result.content === "string" ? result.content : result.content.map((c) => c.text ?? "").join("");
    const listed = JSON.parse(text).builds.flatMap((b) => b.messages.map((m) => m.id));
    assert.ok(!listed.includes(sent.id), `the inbox tool listed ${sent.id} again: ${listed}`);
    assert.ok((await message(sent.id)).read_at);
  });

  test("/relay-reply sends a status reply to the newest message's sender (orchestrator, then human)", { timeout: 120_000 }, async () => {
    await drain();
    const fromOrchestrator = await tell("Reply check: are you there?");
    const replyWord = nonce("REPLY");
    const toOrchestrator = await claude({ plugins: { "relay-inbox": inboxOptions(relay) }, prompt: `/relay-reply ${replyWord} ack from the developer` }).exited;
    assert.equal(toOrchestrator.code, 0, explain(toOrchestrator));
    assert.match(toOrchestrator.text(), new RegExp(`Sent M\\d+ to orchestrator \\(reply to ${fromOrchestrator.id}, build ${buildId}\\)`), explain(toOrchestrator));
    const reply = (await inboxOf("orchestrator")).find((m) => m.body.includes(replyWord));
    assert.ok(reply, "the orchestrator got the reply");
    assert.deepEqual([reply.from, reply.type, reply.reply_to], ["developer", "status", fromOrchestrator.id]);

    await drain();
    const fromHuman = await tell("James here: quick question for you.", "human");
    const humanWord = nonce("REPLY");
    const toHuman = await claude({ plugins: { "relay-inbox": inboxOptions(relay) }, prompt: `/relay-reply ${humanWord} yes, James` }).exited;
    assert.equal(toHuman.code, 0, explain(toHuman));
    assert.match(toHuman.text(), new RegExp(`Sent M\\d+ to human \\(reply to ${fromHuman.id}`), explain(toHuman));
    const humanReply = (await inboxOf("human")).find((m) => m.body.includes(humanWord));
    assert.deepEqual([humanReply?.from, humanReply?.type, humanReply?.reply_to], ["developer", "status", fromHuman.id]);
    assert.equal(cost(toOrchestrator) + cost(toHuman), 0, "a Mod command costs no model tokens");
  });

  test("auto-wake: an idle long-lived headless session starts a turn when a message arrives, and the role answers over MCP", { timeout: 240_000 }, async (t) => {
    await drain();
    const word = nonce("AUTOWAKE");
    const session = claude({ stdin: true, plugins: { "relay-inbox": inboxOptions(relay) }, mcp: { relay, role: "developer" }, maxTurns: 8 });
    let sentAt;
    try {
      session.send("Reply with exactly READY and nothing else. Do not use tools this turn.");
      assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
      await tell(`Wake check: the codeword is ${word}. Send me (orchestrator) a status message containing it.`);
      sentAt = Date.now();
      assert.ok(await session.until((r) => r.results.length >= 2, 120_000), `no turn started by itself\n${explain(session)}`);
      t.diagnostic(`the wake turn ended ${((Date.now() - sentAt) / 1000).toFixed(1)} s after the message was sent`);
    } finally {
      session.end();
      await session.exited;
    }
    const answer = await waitFor(async () => (await inboxOf("orchestrator")).find((m) => m.from === "developer" && m.body.includes(word)), 5_000);
    assert.ok(answer, `the woken role did not answer\n${explain(session)}`);
  });

  test("a message that arrives during a one-shot -p turn is not lost: it stays unread for the next session", { timeout: 180_000 }, async () => {
    await drain();
    const run = claude({
      plugins: { "relay-inbox": inboxOptions(relay) },
      allowedTools: ["Bash(node -e:*)"],
      maxTurns: 4,
      prompt: 'Run exactly this shell command with the Bash tool, in the foreground: node -e "setTimeout(() => console.log(1), 12000)" -- then reply with exactly DONE.',
    });
    await run.until((r) => r.tools().length > 0, 60_000);
    const late = await tell("Arrived mid-turn.");
    await run.exited;
    assert.equal(run.code, 0, explain(run));
    assert.equal((await message(late.id)).read_at, null, "a message the model never saw must stay unread");
  });

  test("relay down, rejected token, relay that never answers: the turn completes and the status line says what is wrong", { timeout: 300_000 }, async (t) => {
    const prompt = "Reply with exactly OK-FAIL and nothing else.";
    const down = await claude({ plugins: { "relay-inbox": inboxOptions(relay, "developer", { relay_url: `http://127.0.0.1:${await deadPort()}` }) }, prompt }).exited;
    assert.equal(down.code, 0, explain(down));
    assert.match(down.text(), /OK-FAIL/);
    assert.ok(down.statusTexts("relay-inbox").some((s) => /^Relay · unreachable \(unreachable: .*\), retrying in \d+s/.test(s)), explain(down));

    const rejected = await claude({ plugins: { "relay-inbox": inboxOptions(relay, "developer", { role_token: `bad-${randomBytes(20).toString("hex")}` }) }, prompt }).exited;
    assert.equal(rejected.code, 0, explain(rejected));
    assert.match(rejected.text(), /OK-FAIL/);
    assert.ok(rejected.statusTexts("relay-inbox").includes("Relay · token rejected (401): check role_token"), explain(rejected));

    const hang = await hangingServer();
    try {
      const slow = await claude({ plugins: { "relay-inbox": inboxOptions(relay, "developer", { relay_url: hang.url }) }, prompt }).exited;
      assert.equal(slow.code, 0, explain(slow));
      assert.match(slow.text(), /OK-FAIL/);
      assert.ok(slow.statusTexts("relay-inbox").some((s) => s.includes("unreachable (timeout: no answer within 3s)")), explain(slow));
      // The Mod gives up after 3 s (a prompt waits at most 1.5 s), but $.http.fetch cannot be aborted: the
      // process exits only when the engine's own request timeout (~30 s) ends the abandoned request.
      t.diagnostic(`hanging relay: the -p run took ${(slow.ms / 1000).toFixed(1)} s (relay down: ${(down.ms / 1000).toFixed(1)} s)`);
      assert.ok(slow.ms < 60_000, `took ${slow.ms} ms`);
    } finally {
      await hang.close();
    }
  });

  test("a message that arrives after the last poll rides the same prompt: the prompt makes its own read", { timeout: 240_000 }, async (t) => {
    await drain();
    const first = nonce("LATEA");
    const second = nonce("LATEB");
    const a = await tell(`Carry check A: codeword ${first}.`);
    const session = claude({ stdin: true, plugins: { "relay-inbox": inboxOptions(relay, "developer", { auto_wake: false }) }, maxTurns: 4 });
    let b;
    try {
      // The first poll lists A only; then B arrives and the person types a prompt.
      assert.ok(await session.until((r) => r.statusTexts("relay-inbox").some((s) => /1 unread/.test(s)), 30_000), explain(session));
      b = await tell(`Carry check B: codeword ${second}.`);
      session.send("List the codewords of every Agent Relay inbox message in your context, oldest first: reply with exactly CODEWORDS=<codewords, comma-separated>. Do not use tools.");
      assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
    } finally {
      session.end();
      await session.exited;
    }
    t.diagnostic(`A read_at ${(await message(a.id)).read_at} · B read_at ${(await message(b.id)).read_at} · results ${JSON.stringify(session.results.map((r) => r.result))}`);
    assert.match(session.text(), new RegExp(`CODEWORDS=${first}, ?${second}`), explain(session));
    assert.ok((await message(a.id)).read_at && (await message(b.id)).read_at, "both handed over, both read");
  });

  test("a read that answers after the prompt's 1.5 s: the prompt carries a recovery cursor, and inbox {since} lists the message again", { timeout: 180_000 }, async (t) => {
    await drain();
    const word = nonce("RECOVER");
    const sent = await tell(`Recovery check: the codeword is ${word}.`);
    // The read marks the message read at once; its answer reaches the Mod only after 20 s, long after the prompt went.
    const proxy = await slowProxy(relay.url, slowReads(20_000));
    let run;
    try {
      run = await claude({
        plugins: { "relay-inbox": inboxOptions(relay, "developer", { relay_url: proxy.url, auto_wake: false }) },
        mcp: { relay, role: "developer" },
        maxTurns: 5,
        prompt: "What codeword did the orchestrator send you over the relay? Check your context, and use the relay tools as it says. Reply as CODEWORD=<codeword> or CODEWORD=none.",
      }).exited;
    } finally {
      await proxy.close();
    }
    assert.equal(run.code, 0, explain(run));
    const since = sent.seq - 1;
    const calls = run.tools().filter((c) => c.name === "mcp__relay__inbox").map((c) => c.input);
    t.diagnostic(`held answers: ${JSON.stringify(proxy.held)} · inbox calls: ${JSON.stringify(calls)} · answer: ${run.text()}`);
    assert.ok(proxy.held.length >= 1, "the Mod's read went through the slow proxy");
    assert.ok((await message(sent.id)).read_at, "the read marked the message read on the relay");
    assert.ok(calls.some((input) => input.build_id === buildId && input.since === since), `the model did not call inbox {build_id: ${buildId}, since: ${since}}\n${explain(run)}`);
    assert.match(run.text(), new RegExp(`CODEWORD=${word}`), explain(run));
  });

  test("a late read's messages, added as a row after the turn ended, wake the idle session and reach the model", { timeout: 240_000 }, async (t) => {
    await drain();
    const word = nonce("ROWWAKE");
    await tell(`Row check: reply with exactly ${word} and nothing else.`);
    // The prompt goes without the message at 1.5 s; its read's answer comes 8 s later, after that turn's only request.
    const proxy = await slowProxy(relay.url, slowReads(8_000));
    const session = claude({ stdin: true, plugins: { "relay-inbox": inboxOptions(relay, "developer", { relay_url: proxy.url }) }, maxTurns: 3 });
    try {
      assert.ok(await session.until((r) => r.statusTexts("relay-inbox").some((s) => /1 unread/.test(s)), 30_000), explain(session));
      session.send("Reply with exactly READY and nothing else. Do not use tools this turn.");
      assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
      assert.ok(await session.until((r) => r.results.length >= 2, 60_000), `no wake turn after the late row\n${explain(session)}`);
    } finally {
      session.end();
      await session.exited;
      await proxy.close();
    }
    t.diagnostic(`results: ${JSON.stringify(session.results.map((r) => r.result))} · held answers: ${proxy.held.length}`);
    assert.doesNotMatch(session.results[0].result, new RegExp(word), "the first turn did not have the message");
    assert.match(session.results[1].result, new RegExp(word), `the wake turn did not read the row\n${explain(session)}`);
  });

  test("while the kill switch is on, a prompt carries no relay messages and they are still unread once it is cleared", { timeout: 180_000 }, async (t) => {
    await drain();
    const word = nonce("HALTED");
    const sent = await tell(`Kill switch check: codeword ${word}.`);
    await ok(relay.call("human", "kill_switch", { on: true, reason: "live Mod check" }));
    let run;
    try {
      run = await claude({
        plugins: { "relay-inbox": inboxOptions(relay) },
        prompt: "If an Agent Relay inbox message is in your context, reply SEEN=<its codeword>; otherwise reply exactly SEEN=none. Do not use tools.",
      }).exited;
    } finally {
      await ok(relay.call("human", "kill_switch", { on: false }));
    }
    assert.equal(run.code, 0, explain(run));
    assert.ok(run.statusTexts("relay-inbox").some((s) => s.startsWith("Relay · halted: live Mod check · 1 unread")), explain(run));
    t.diagnostic(`model: ${run.text()} · ${sent.id} read_at ${(await message(sent.id)).read_at}`);
    assert.ok(!run.text().includes(word), `the model was handed ${word} during the halt`);
    assert.equal((await message(sent.id)).read_at, null, `${sent.id} was marked read during the halt`);
    const unread = (await ok(relay.call("developer", "inbox", { build_id: buildId, peek: true }))).builds[0].messages.map((m) => m.id);
    assert.ok(unread.includes(sent.id), `${sent.id} is gone from the inbox after the halt`);
  });
});

// =========================================================================== relay-inbox and finishing handoffs

describe("relay-inbox and a finishing handoff", { skip: SKIP }, () => {
  let relay;
  before(async () => {
    relay = await startRelay();
  });
  after(async () => {
    await relay?.stop();
  });

  test("a finishing handoff: the injected header names the task the recipient now continues on (next_task_id)", { timeout: 180_000 }, async (t) => {
    const build = await ok(relay.call("human", "build_create", { title: "Handoff check", brief: "x", gates: { plan_approval: false, final_signoff: false } }));
    const id = build.build_id;
    const design = (await ok(relay.call("orchestrator", "ledger_update", { build_id: id, title: "Design the screen", assignee: "creative-director" }))).task;
    // A task in between, so the next task is not simply the one after the finished one.
    await ok(relay.call("orchestrator", "ledger_update", { build_id: id, title: "Write the copy", assignee: "creative-director" }));
    const buildTask = (await ok(relay.call("orchestrator", "ledger_update", { build_id: id, title: "Build the screen", assignee: "developer", depends_on: [design.id] }))).task;
    await ok(relay.call("orchestrator", "gate_request", { build_id: id, kind: "plan_approval", summary: "Design, then build." }));
    await ok(relay.call("developer", "inbox", { peek: false, limit: 100 }));
    const handoff = (await ok(relay.call("creative-director", "send", { build_id: id, to_role: "developer", type: "handoff", task_id: design.id, next_task_id: buildTask.id, body: "The design is finished; the spec is linked.", links: [{ url: "https://example.com/spec", label: "Spec" }] }))).message;
    assert.equal(handoff.next_task_id, buildTask.id, "the relay keeps next_task_id on the message");
    const run = await claude({
      plugins: { "relay-inbox": inboxOptions(relay, "developer", { auto_wake: false }) },
      prompt: "An Agent Relay handoff is in your context. Reply on one line, exactly: FINISHED=<the task id it hands off as finished> NEXT=<the task id you now continue on>. Do not use tools.",
    }).exited;
    assert.equal(run.code, 0, explain(run));
    t.diagnostic(`tasks ${design.id} → ${buildTask.id} · answer: ${run.text()}`);
    assert.match(run.text(), new RegExp(`NEXT=${buildTask.id}\\b`), explain(run));
    assert.match(run.text(), new RegExp(`FINISHED=${design.id}\\b`), explain(run));
    assert.ok((await ok(relay.call("human", "ledger_get", { build_id: id }))).messages.find((m) => m.id === handoff.id).read_at, "handed over, so read");
  });
});

// =========================================================================== relay-inbox and nudges

describe("relay-inbox /relay-reply to a nudge", { skip: SKIP }, () => {
  let relay;
  before(async () => {
    relay = await startRelay({ vars: { NUDGE_AFTER_MINUTES: "0.25" } });
  });
  after(async () => {
    await relay?.stop();
  });

  test("counts as activity on the nudged task (the reply names it), so it does not escalate to the human", { timeout: 180_000 }, async (t) => {
    const build = await ok(relay.call("human", "build_create", { title: "Nudge reply", brief: "x", gates: { plan_approval: false, final_signoff: false } }));
    const task = (await ok(relay.call("orchestrator", "ledger_update", { build_id: build.build_id, title: "Build the list screen", assignee: "developer" }))).task;
    await ok(relay.call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "One task." }));
    const nudge = await waitFor(async () => {
      const box = await ok(relay.call("developer", "inbox", { build_id: build.build_id, peek: true }));
      return box.builds[0].messages.find((m) => m.from === "relay" && m.task_id === task.id);
    }, 60_000, 1_000);
    assert.ok(nudge, "no nudge arrived");
    assert.deepEqual([nudge.task_id, nudge.on_behalf_of], [task.id, "orchestrator"]);

    const run = await claude({ plugins: { "relay-inbox": inboxOptions(relay) }, prompt: `/relay-reply Working on ${task.id}, list screen half done.` }).exited;
    assert.equal(run.code, 0, explain(run));
    assert.match(run.text(), new RegExp(`Sent M\\d+ to orchestrator \\(reply to ${nudge.id}`), explain(run));

    await sleep(20_000); // past the second-miss window (15 s after the nudge)
    const ledger = await ok(relay.call("human", "ledger_get", { build_id: build.build_id }));
    const reply = ledger.messages.find((m) => m.from === "developer");
    const stalled = ledger.messages.find((m) => m.to === "human" && m.body.startsWith("Stalled:"));
    const row = ledger.tasks.find((one) => one.id === task.id);
    t.diagnostic(`reply ${JSON.stringify({ id: reply?.id, task_id: reply?.task_id, reply_to: reply?.reply_to })} · task ${JSON.stringify({ nudge_count: row.nudge_count, stalled: row.stalled })}`);
    assert.deepEqual([reply?.task_id, reply?.reply_to, reply?.type], [task.id, nudge.id, "status"], "the reply names the nudged task and the nudge");
    assert.equal(stalled, undefined, `escalated to the human although the owner replied: ${stalled?.body}`);
    assert.equal(row.stalled, false);
    assert.ok(row.nudge_count <= 1, `the reply did not reset the nudges: nudge_count ${row.nudge_count}`);
  });
});

// =========================================================================== relay-inbox and the orchestrator's own nudge

describe("relay-inbox /relay-reply in the orchestrator's session", { skip: SKIP }, () => {
  let relay;
  before(async () => {
    // 30 s: the nudge is the orchestrator's newest message for 30 s, until the second-miss notice follows it.
    relay = await startRelay({ vars: { NUDGE_AFTER_MINUTES: "0.5" } });
  });
  after(async () => {
    await relay?.stop();
  });

  test("a nudge the relay sent on behalf of the orchestrator about its own task: nothing is sent, and it says to answer with ledger_update", { timeout: 180_000 }, async (t) => {
    const build = await ok(relay.call("human", "build_create", { title: "Own nudge", brief: "x", gates: { plan_approval: false, final_signoff: false } }));
    const id = build.build_id;
    const task = (await ok(relay.call("orchestrator", "ledger_update", { build_id: id, title: "Re-plan the screens", assignee: "orchestrator" }))).task;
    await ok(relay.call("orchestrator", "gate_request", { build_id: id, kind: "plan_approval", summary: "One task, mine." }));
    const nudge = await waitFor(async () => {
      const box = await ok(relay.call("orchestrator", "inbox", { build_id: id, peek: true }));
      return box.builds[0].messages.find((m) => m.from === "relay" && m.task_id === task.id && m.on_behalf_of === "orchestrator");
    }, 90_000, 1_000);
    assert.ok(nudge, "no nudge to the orchestrator about its own task");

    const run = await claude({ plugins: { "relay-inbox": inboxOptions(relay, "orchestrator", { auto_wake: false }) }, prompt: `/relay-reply Re-planning ${task.id} now.` }).exited;
    assert.equal(run.code, 0, explain(run));
    t.diagnostic(`nudge ${nudge.id} to ${nudge.to} for ${nudge.on_behalf_of} · answer: ${run.text()}`);
    assert.ok(run.text().includes(`${nudge.id} is a relay nudge sent on behalf of you (orchestrator) about ${task.id}: a reply would go to yourself, so nothing was sent.`), explain(run));
    assert.ok(run.text().includes(`Answer it with ledger_update {build_id: "${id}", task_id: "${task.id}", note: "<what you are doing>"} instead.`), explain(run));
    const ledger = await ok(relay.call("human", "ledger_get", { build_id: id }));
    assert.deepEqual(ledger.messages.filter((m) => m.from === "orchestrator" && m.type === "status"), [], "the Mod sent nothing");
  });
});
