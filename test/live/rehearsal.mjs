#!/usr/bin/env node
// Live rehearsal of the PRD loop (milestones 3, 4 and 6) with real Claude agents.
//
// Each role runs as a local Claude Code session (PRD Plan B): `claude -p` with
// the relay as its only MCP server, the protocol snippet + role addendum as its
// instructions, and `--resume` so every wake continues the same conversation.
// This driver stands in for the inbox Mod's wake path (it polls the relay with
// peek and wakes a role with the Mod's exact wake prompt) and for James (it
// answers gates and questions). Everything the agents do goes through the relay.
//
//   RUN_LIVE=1 node test/live/rehearsal.mjs [--model sonnet] [--minutes 45] [--max-invocations 40] [--out <dir>]
//                                           [--nudge <minutes>] [--title <build title> --brief-file <file>]
//
// It costs real model usage. Output: <out>/report.md, report.json, ws/ (the app), logs/.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startRelay } from "../e2e/harness.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS = ["orchestrator", "creative-director", "developer"];

const { values: opts } = parseArgs({
  options: {
    model: { type: "string", default: "sonnet" },
    minutes: { type: "string", default: "45" },
    "max-invocations": { type: "string", default: "40" },
    out: { type: "string" },
    nudge: { type: "string", default: "4" },
    title: { type: "string", default: "Split the bill" },
    "brief-file": { type: "string" },
  },
});
if (process.env.RUN_LIVE !== "1") {
  console.log("Skipped: set RUN_LIVE=1 to run the live rehearsal (it uses real model calls).");
  process.exit(0);
}

const out = resolve(opts.out ?? join(tmpdir(), `agent-relay-rehearsal-${Date.now()}`));
const ws = join(out, "ws");
const logs = join(out, "logs");
for (const d of [join(ws, "app"), join(ws, "design"), logs]) mkdirSync(d, { recursive: true });
const deadline = Date.now() + Number(opts.minutes) * 60_000;
const maxInvocations = Number(opts["max-invocations"]);
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const say = (line) => console.log(`[${since()}] ${line}`);

// --- static preview server: <base>/app/ and <base>/design/ ---------------------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const preview = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(ws, path));
  if (file !== ws && !file.startsWith(ws + sep)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => preview.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${preview.address().port}`;

// --- relay ------------------------------------------------------------------------
const relay = await startRelay({ vars: { NUDGE_AFTER_MINUTES: opts.nudge } });
say(`relay ${relay.url} · preview ${base} · out ${out}`);

const protocol = readFileSync(join(REPO, "protocol", "PROTOCOL.md"), "utf8");
const addendum = (role) => readFileSync(join(REPO, "protocol", "roles", `${role}.md`), "utf8");
const DISPLAY = { orchestrator: "Orchestrator", "creative-director": "Creative Director", developer: "Full-Stack Developer" };

function projectInstructions(role) {
  return `You are the ${DISPLAY[role]} in James's Agent Relay team. You work alone in this session; the other roles are separate agents you reach only through the relay MCP tools (mcp__relay__*).

Rehearsal environment:
- Shared workspace (your working directory): ${ws}
- A static preview server serves that folder at ${base}/ — a file at ${ws}/app/index.html is live at ${base}/app/ and ${ws}/design/spec.md at ${base}/design/spec.md. Use these http URLs as links in messages; the other roles can open them with curl.
- Design specs live under ${ws}/design/ (Creative Director). The app lives under ${ws}/app/ (Developer). There is no git remote here: writing files under ${ws}/app/ IS deploying the preview, so "deploy only from a pushed commit" does not apply in this rehearsal.
- Fetch pages with: curl -s <url>. No other network access is needed.
- James (the human) answers gates and questions through the relay; never wait for him inside a turn.

--- Project instructions: relay protocol ---
${protocol}

--- Project instructions: your role ---
${addendum(role)}`;
}

for (const role of AGENTS) {
  writeFileSync(join(logs, `${role}.instructions.md`), projectInstructions(role));
  writeFileSync(
    join(logs, `${role}.mcp.json`),
    JSON.stringify({ mcpServers: { relay: { type: "http", url: relay.mcpUrl(role), headers: { Authorization: `Bearer ${relay.tokens[role]}` } } } }),
  );
}

// The child sessions must not inherit this process's Claude Code session identity.
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (/^CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|MESSAGING_|TEE_SDK_STDOUT|DIAGNOSTICS_FILE|CHILD_SESSION|SYNC_SESSION_REFS|POST_FOR_SESSION_INGRESS|CCR_EVENT_FLUSH|REMOTE_SEND_KEEPALIVES|INCLUDE_PARTIAL_MESSAGES)/.test(key) || key === "CLAUDE_PID" || key === "CLAUDECODE") {
    delete childEnv[key];
  }
}
childEnv.NO_PROXY = childEnv.no_proxy = "127.0.0.1,localhost";

const state = Object.fromEntries(AGENTS.map((r) => [r, { sessionId: randomUUID(), started: false, running: false, invocations: 0, costUsd: 0, turns: 0 }]));
let invocations = 0;

function runRole(role, prompt) {
  const s = state[role];
  s.running = true;
  s.invocations += 1;
  invocations += 1;
  const n = s.invocations;
  const args = [
    "-p", prompt,
    "--model", opts.model,
    "--output-format", "json",
    "--max-turns", "60",
    "--mcp-config", join(logs, `${role}.mcp.json`),
    "--strict-mcp-config",
    "--append-system-prompt", projectInstructions(role),
    "--setting-sources", "project",
    "--disable-slash-commands",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "mcp__relay__* Read Write Edit Glob Grep Bash(curl:*) Bash(ls:*) Bash(mkdir:*) Bash(cat:*)",
    ...(s.started ? ["--resume", s.sessionId] : ["--session-id", s.sessionId]),
  ];
  s.started = true;
  say(`wake ${role} #${n}: ${prompt.slice(0, 90)}`);
  return new Promise((done) => {
    const child = spawn("claude", args, { cwd: ws, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      s.running = false;
      writeFileSync(join(logs, `${role}.${String(n).padStart(2, "0")}.json`), stdout || stderr);
      try {
        const r = JSON.parse(stdout);
        s.costUsd += r.total_cost_usd ?? 0;
        s.turns += r.num_turns ?? 0;
        say(`done ${role} #${n} (exit ${code}, ${r.num_turns} turns, $${(r.total_cost_usd ?? 0).toFixed(2)}): ${String(r.result ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
      } catch {
        say(`done ${role} #${n} (exit ${code}) — unparsable output: ${(stderr || stdout).slice(0, 300)}`);
      }
      done();
    });
  });
}

// --- James, simulated -------------------------------------------------------------
const touchpoints = [];
async function actAsJames() {
  const inbox = await relay.call("human", "inbox", {});
  if (!inbox.ok) return;
  for (const b of inbox.result.builds) {
    for (const m of b.messages) {
      if (m.type === "question" && m.from !== "relay") {
        await relay.call("human", "send", {
          build_id: b.build_id, to_role: m.from, type: "status", reply_to: m.id,
          body: "James: use your judgement and keep it simple; the brief is the spec.",
        });
        touchpoints.push({ at: since(), kind: "answer", detail: `${m.id} from ${m.from}` });
        say(`James answered ${m.id} from ${m.from}`);
      }
    }
    for (const g of b.pending_gates) {
      const note = g.kind === "final_signoff" ? "Signed off. Ship it." : g.kind === "plan_approval" ? "Plan approved. Go." : "One more round, then ship what you have.";
      const r = await relay.call("human", "gate_decide", { build_id: b.build_id, gate_id: g.id, decision: "approved", note, ...(g.kind === "escalation" ? { extra_rounds: 1 } : {}) });
      touchpoints.push({ at: since(), kind: g.kind, detail: `${g.id} ${r.ok ? "approved" : r.error?.code}` });
      say(`James decided ${g.kind} ${g.id}: ${r.ok ? "approved" : JSON.stringify(r.error)}`);
    }
  }
}

async function unreadFor(role) {
  const res = await fetch(`${relay.url}/api/inbox?peek=1&limit=100`, { headers: { authorization: `Bearer ${relay.tokens[role]}` } });
  const env = await res.json();
  if (!env.ok) return { count: 0, builds: [] };
  const builds = env.result.builds.filter((b) => b.messages.length + b.unread_remaining > 0);
  return { count: builds.reduce((n, b) => n + b.messages.length + b.unread_remaining, 0), builds: builds.map((b) => b.build_id) };
}

// --- kickoff ------------------------------------------------------------------------
const DEFAULT_BRIEF = `Build a small single-page "Split the bill" tip calculator web app.
- Inputs: bill amount, tip percentage (quick picks 15 / 18 / 20 % plus custom), number of people (stepper, min 1).
- Output: tip amount, total, and per-person amount, updating live as inputs change; a Reset button.
- Plain static HTML/CSS/JS, no build step, no external requests; mobile-first, works at 360 px wide, accessible (labels, focus states, contrast).
- One screen is enough. Keep the plan small: this is a rehearsal of the team loop, not a big project.`;
const BRIEF = opts["brief-file"] ? readFileSync(opts["brief-file"], "utf8") : DEFAULT_BRIEF;
const created = await relay.call("human", "build_create", { title: opts.title, brief: BRIEF });
if (!created.ok) throw new Error(`build_create failed: ${JSON.stringify(created.error)}`);
const buildId = created.result.build_id;
touchpoints.push({ at: since(), kind: "kickoff", detail: buildId });
say(`kickoff ${buildId}`);

// --- loop ---------------------------------------------------------------------------
const running = new Set();
let finalStatus = "unknown";
const WAKE = (n, ids) => `[relay] ${n} new relay message(s) for build ${ids.join(", ")}. Check your relay inbox and act per the relay protocol.`;
try {
  for (;;) {
    await actAsJames();
    const ledger = await relay.call("human", "ledger_get", { build_id: buildId });
    finalStatus = ledger.result?.build?.status ?? finalStatus;
    if (["shipped", "cancelled", "halted"].includes(finalStatus)) {
      say(`build ${finalStatus}`);
      break;
    }
    if (Date.now() > deadline) {
      say("time limit reached");
      break;
    }
    for (const role of AGENTS) {
      if (state[role].running || invocations >= maxInvocations) continue;
      const { count, builds } = await unreadFor(role);
      if (count > 0) {
        const p = runRole(role, WAKE(count, builds)).finally(() => running.delete(p));
        running.add(p);
      }
    }
    if (invocations >= maxInvocations && running.size === 0) {
      say("invocation limit reached");
      break;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  await Promise.all(running);
} finally {
  const ledger = (await relay.call("human", "ledger_get", { build_id: buildId })).result;
  const report = buildReport(ledger);
  writeFileSync(join(out, "report.json"), JSON.stringify({ report, ledger, touchpoints, state }, null, 2));
  writeFileSync(join(out, "report.md"), renderReport(report, ledger));
  await screenshotApp().catch((e) => say(`no app screenshot: ${e.message}`));
  say(`report: ${join(out, "report.md")}`);
  await relay.stop();
  preview.close();
}

// Best effort: a phone-width screenshot of the preview, when Playwright is installed.
async function screenshotApp() {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/app/`);
    await page.screenshot({ path: join(out, "app.png"), fullPage: true });
    say(`app screenshot: ${join(out, "app.png")}`);
  } finally {
    await browser.close();
  }
}

function buildReport(ledger) {
  const msgs = ledger?.messages ?? [];
  const tasks = ledger?.tasks ?? [];
  return {
    build_id: buildId,
    status: ledger?.build?.status,
    minutes: +((Date.now() - t0) / 60_000).toFixed(1),
    model: opts.model,
    agent_invocations: Object.fromEntries(AGENTS.map((r) => [r, state[r].invocations])),
    agent_turns: Object.fromEntries(AGENTS.map((r) => [r, state[r].turns])),
    cost_usd: +AGENTS.reduce((n, r) => n + state[r].costUsd, 0).toFixed(2),
    human_touchpoints: touchpoints.filter((t) => t.kind !== "kickoff").length,
    touchpoints,
    agent_messages: ledger?.build?.message_count,
    review_rounds: Object.fromEntries(tasks.map((t) => [t.id, t.round])),
    escalations: (ledger?.gates ?? []).filter((g) => g.kind === "escalation").length,
    nudges: msgs.filter((m) => m.from === "relay" && /nudge/i.test(m.body)).length,
    stalled_tasks: tasks.filter((t) => t.stalled).map((t) => t.id),
    app_files: existsSync(join(ws, "app")) ? listFiles(join(ws, "app")) : [],
    preview_url: `${base}/app/`,
  };
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile());
}

function renderReport(r, ledger) {
  const lines = [
    `# Live rehearsal — ${r.build_id}`,
    "",
    `Status **${r.status}** after ${r.minutes} min · model ${r.model} · $${r.cost_usd} · human touchpoints ${r.human_touchpoints} · agent messages ${r.agent_messages} · escalations ${r.escalations} · nudges ${r.nudges} · stalled ${r.stalled_tasks.length}`,
    "",
    "| Role | Wakes | Turns |",
    "|---|---|---|",
    ...AGENTS.map((a) => `| ${a} | ${r.agent_invocations[a]} | ${r.agent_turns[a]} |`),
    "",
    "## Tasks",
    "",
    "| Task | Title | Status | Rounds | Assignee | Reviewer |",
    "|---|---|---|---|---|---|",
    ...(ledger?.tasks ?? []).map((t) => `| ${t.id} | ${t.title} | ${t.status} | ${t.round}/${t.max_rounds} | ${t.assignee} | ${t.reviewer ?? ""} |`),
    "",
    "## Human touchpoints",
    "",
    ...r.touchpoints.map((t) => `- ${t.at} ${t.kind}: ${t.detail}`),
    "",
    "## Messages (last 50)",
    "",
    ...(ledger?.messages ?? []).map((m) => `- **${m.id}** ${m.from}${m.on_behalf_of ? ` (for ${m.on_behalf_of})` : ""} → ${m.to} · ${m.type}${m.task_id ? ` · ${m.task_id}` : ""}${m.verdict ? ` · ${m.verdict}` : ""}: ${m.body.replace(/\s+/g, " ").slice(0, 220)}${(m.changes ?? []).length ? ` — changes: ${m.changes.map((c, i) => `${i + 1}. ${c}`).join(" ")}` : ""}${(m.links ?? []).length ? ` — links: ${m.links.map((l) => l.url).join(", ")}` : ""}`),
  ];
  return lines.join("\n") + "\n";
}
