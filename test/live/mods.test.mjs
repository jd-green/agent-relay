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
// here (--strict-mcp-config). Tests marked `todo` reproduce known defects: they run and report, but do
// not fail the suite until the defect is fixed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(marker, /^[0-9a-f]{8}$/);
    assert.equal(events.find((e) => e.event === "context.injected").detail.nonce, marker);
    assert.match(run.text(), new RegExp(`MARKER=${marker}`), `the model did not quote the marker ${marker}\n${explain(run)}`);
    assert.match(run.text(), new RegExp(`WORD=${fileSecret}`), "the Read tool really ran");

    const raw = JSON.stringify(events);
    for (const secret of [promptSecret, fileSecret, "quick brown", "notes.txt", relay.tokens.developer, "Read the file"]) {
      assert.ok(!raw.includes(secret), `a spike record carries ${JSON.stringify(secret)}`);
    }
    t.diagnostic(`session.start detail: ${JSON.stringify(start.detail)} · cost $${cost(run).toFixed(4)}`);
  });

  test("a wake queued for a session before it starts is consumed and runs as a second turn", { timeout: 180_000 }, async (t) => {
    const sessionId = randomUUID();
    const word = nonce("WAKE");
    const queued = await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ session_id: sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` }) }));
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
      await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ session_id: session.sessionId, text: `Spike wake: reply with exactly ${word} and nothing else.` }) }));
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

  test("a wake that arrives while a turn runs is consumed and recorded as wake.skipped_busy", { timeout: 180_000 }, async (t) => {
    const sessionId = randomUUID();
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
      wakeId = (await ok(asHuman(relay, "/spike/wake", { method: "POST", body: JSON.stringify({ session_id: sessionId, text: "Spike wake: reply BUSY." }) }))).wake.id;
      return true;
    }, 60_000, 500);
    const run = await session.exited;
    await queued;
    assert.equal(run.code, 0, explain(run));
    assert.ok(wakeId, `the turn never called a tool, so no wake was queued\n${explain(run)}`);
    const events = await spikeEventsAfterEnd(relay, sessionId);
    const names = events.map((e) => e.event);
    t.diagnostic(`events: ${events.map((e) => `${e.ts.slice(11, 19)} ${e.event}`).join(", ")}`);
    assert.deepEqual(events.filter((e) => e.event === "wake.skipped_busy").map((e) => e.detail.wake_id), [wakeId], names.join(", "));
    assert.ok(!names.includes("wake.submitted"), "a busy session must not submit the wake");
    assert.equal(names.filter((n) => n === "turn.start").length, 1, "no second turn ran");
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

  test("an unread message reaches the model with the next prompt and the relay marks it read", { timeout: 180_000 }, async (t) => {
    await drain();
    const word = nonce("INBOX");
    const sent = await tell(`Live check: the codeword is ${word}. Please confirm you can see it.`);
    const run = await claude({
      plugins: { "relay-inbox": inboxOptions(relay) },
      prompt: "Is there an Agent Relay inbox message in your context? If so reply with exactly CODEWORD=<the codeword from its body>, otherwise CODEWORD=none. Do not use tools.",
    }).exited;
    assert.equal(run.code, 0, explain(run));
    t.diagnostic(`statuses: ${JSON.stringify(run.statusTexts("relay-inbox"))}`);
    assert.match(run.text(), new RegExp(`CODEWORD=${word}`), explain(run));
    assert.ok(run.statusTexts("relay-inbox").some((s) => /^Relay · 1 unread · b-/.test(s)), "the status line counted the unread message");
    const row = await message(sent.id);
    assert.ok(row.read_at, `${sent.id} was not marked read`);
    const thread = (await ok(relay.call("human", "ledger_get", { build_id: buildId }))).threads.find((th) => th.role === "developer");
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
      assert.ok(slow.statusTexts("relay-inbox").some((s) => s.includes("unreachable (timeout: no answer within 8s)")), explain(slow));
      // The Mod gives up after 8 s, but $.http.fetch cannot be aborted: the process exits only when the
      // engine's own request timeout (~30 s) ends the abandoned request.
      t.diagnostic(`hanging relay: the -p run took ${(slow.ms / 1000).toFixed(1)} s (relay down: ${(down.ms / 1000).toFixed(1)} s)`);
      assert.ok(slow.ms < 60_000, `took ${slow.ms} ms`);
    } finally {
      await hang.close();
    }
  });

  test(
    "a message marked read alongside an injected batch reaches the model (known defect: it is 'carried' and never handed over by a wake)",
    { timeout: 240_000, todo: "relay-inbox markRead marks every unread message read, but carried ones only ride a prompt that passes the Mod's own prompt.submit hook" },
    async (t) => {
      await drain();
      const first = nonce("CARRYA");
      const second = nonce("CARRYB");
      const a = await tell(`Carry check A: codeword ${first}.`);
      const session = claude({ stdin: true, plugins: { "relay-inbox": inboxOptions(relay) }, mcp: { relay, role: "developer" }, maxTurns: 8 });
      let b;
      try {
        // Once the first poll has listed A, B arrives and the person types a prompt: A is injected, A and B are marked read.
        assert.ok(await session.until((r) => r.statusTexts("relay-inbox").some((s) => /1 unread/.test(s)), 30_000), explain(session));
        b = await tell(`Carry check B: codeword ${second}. Send me (orchestrator) a status message containing it.`);
        session.send("Reply with exactly READY and nothing else. Do not use tools this turn.");
        assert.ok(await session.until((r) => r.results.length >= 1, 90_000), explain(session));
        // The Mod still shows B as unread and wakes the session for it.
        await session.until((r) => r.results.length >= 2, 60_000);
      } finally {
        session.end();
        await session.exited;
      }
      t.diagnostic(`A read_at ${(await message(a.id)).read_at} · B read_at ${(await message(b.id)).read_at} · results ${JSON.stringify(session.results.map((r) => r.result))}`);
      const answered = (await inboxOf("orchestrator")).some((m) => m.from === "developer" && m.body.includes(second));
      assert.ok(answered || session.text().includes(second), `B (${b.id}) was marked read but the model never saw ${second}`);
    },
  );

  test(
    "messages injected while the kill switch is on are still unread once it is cleared (known defect)",
    { timeout: 180_000, todo: "relay-inbox injects and marks read messages while the relay is halted, without telling the model it is halted" },
    async (t) => {
      await drain();
      const word = nonce("HALTED");
      const sent = await tell(`Kill switch check: codeword ${word}.`);
      await ok(relay.call("human", "kill_switch", { on: true, reason: "live Mod check" }));
      let run;
      try {
        run = await claude({
          plugins: { "relay-inbox": inboxOptions(relay) },
          prompt: "If an Agent Relay inbox message is in your context, reply SEEN=<its codeword> HALTED=<yes|no|unknown: is the relay halted?>; otherwise SEEN=none.",
        }).exited;
      } finally {
        await ok(relay.call("human", "kill_switch", { on: false }));
      }
      assert.equal(run.code, 0, explain(run));
      assert.ok(run.statusTexts("relay-inbox").some((s) => s.startsWith("Relay · halted: live Mod check")), explain(run));
      t.diagnostic(`model: ${run.text()} · ${sent.id} read_at ${(await message(sent.id)).read_at}`);
      const unread = (await ok(relay.call("developer", "inbox", { build_id: buildId, peek: true }))).builds[0].messages.map((m) => m.id);
      assert.ok(unread.includes(sent.id), `${sent.id} was consumed during the halt and is gone from the inbox after resume`);
    },
  );
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

  test(
    "counts as activity on the nudged task, so it does not escalate to the human (known defect)",
    { timeout: 180_000, todo: "relay-inbox replies without task_id, and the relay counts only messages that name the task" },
    async (t) => {
      const build = await ok(relay.call("human", "build_create", { title: "Nudge reply", brief: "x", gates: { plan_approval: false, final_signoff: false } }));
      const task = (await ok(relay.call("orchestrator", "ledger_update", { build_id: build.build_id, title: "Build the list screen", assignee: "developer" }))).task;
      await ok(relay.call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "One task." }));
      const nudge = await waitFor(async () => {
        const box = await ok(relay.call("developer", "inbox", { build_id: build.build_id, peek: true }));
        return box.builds[0].messages.find((m) => m.from === "relay");
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
      t.diagnostic(`reply ${JSON.stringify({ id: reply?.id, task_id: reply?.task_id, reply_to: reply?.reply_to })} · task ${JSON.stringify({ nudge_count: ledger.tasks[0].nudge_count, stalled: ledger.tasks[0].stalled })}`);
      assert.equal(reply?.task_id, task.id, "the reply names the nudged task");
      assert.equal(stalled, undefined, `escalated to the human although the owner replied: ${stalled?.body}`);
    },
  );
});
