// End-to-end tests of the relay Worker: a real `wrangler dev` per scenario group
// (test/e2e/harness.mjs), driven through the official MCP SDK client (one client per
// role, some with the Authorization header, some with the /mcp/<token> path form) and
// the JSON API, checked against docs/DESIGN.md and docs/PRD.md.
//
//   NO_PROXY=127.0.0.1,localhost node --test test/e2e/relay.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startRelay } from "./harness.mjs";
import {
  BUILD_ID,
  ISO,
  ROLES,
  assertAudit,
  assertFields,
  assertNoUnread,
  auditCursor,
  closeTeam,
  connect,
  connectTeam,
  deliver,
  entryFor,
  http,
  normalize,
  rpc,
  sleep,
  stepper,
  taskIn,
  waitFor,
} from "./relay-helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROTOCOL = readFileSync(join(REPO, "protocol/PROTOCOL.md"), "utf8");
const ADDENDA = Object.fromEntries(ROLES.map((role) => [role, readFileSync(join(REPO, `protocol/roles/${role}.md`), "utf8")]));

// DESIGN §10, Tools table, "Roles" column.
const TOOLS_BY_ROLE = {
  orchestrator: ["whoami", "build_create", "build_list", "send", "inbox", "ledger_get", "ledger_update", "gate_request"],
  "creative-director": ["whoami", "build_list", "send", "inbox", "ledger_get", "ledger_update"],
  developer: ["whoami", "build_list", "send", "inbox", "ledger_get", "ledger_update"],
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
};
const READ_ONLY_TOOLS = new Set(["whoami", "build_list", "ledger_get"]);

const BRIEF = "Build a one-screen tip calculator web app: bill, tip percent and split; mobile first.";
const SPEC = { url: "https://docs.example.com/tip-calc/spec", label: "Design spec" };
const PREVIEW_1 = { url: "https://tip-calc-r1.pages.dev/", label: "Preview" };
const COMMIT_1 = { url: "https://github.com/example/tip-calc/commit/1a2b3c4", label: "Commit 1a2b3c4" };
const PREVIEW_2 = { url: "https://tip-calc-r2.pages.dev/", label: "Preview" };
const COMMIT_2 = { url: "https://github.com/example/tip-calc/commit/5d6e7f8", label: "Commit 5d6e7f8" };
const PRODUCTION = { url: "https://tip-calc.pages.dev/", label: "Production" };
const REPO_LINK = { url: "https://github.com/example/tip-calc", label: "Repo" };
const CHANGES = ["Header title: 20px/600 per spec, currently 16px/400", "Tip buttons: 44px touch target, currently 32px"];

const owners = (summary) => summary.owners.map(({ task_id, owner }) => ({ task_id, owner }));

/** Human creates a build, the orchestrator adds tasks and gets the plan approved (or auto-approved), then assigns them. */
async function startBuild(team, { gates = { plan_approval: false }, caps, tasks, assign = true, title = "Tip calculator" } = {}) {
  const { orchestrator: o, human } = team;
  const list = tasks ?? [{ title: "Calculator screen", assignee: "developer", reviewer: "creative-director" }];
  const build = await human.call("build_create", { title, brief: BRIEF, gates, ...(caps ? { caps } : {}) });
  const buildId = build.build_id;
  for (const task of list) await o.call("ledger_update", { build_id: buildId, ...task });
  const { gate } = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan: see tasks." });
  if (gate.status === "pending") await human.call("gate_decide", { build_id: buildId, gate_id: gate.id, decision: "approved" });
  if (assign) {
    for (const [index, task] of list.entries()) {
      await o.call("send", { build_id: buildId, to_role: task.assignee, type: "task", task_id: `T${index + 1}`, body: "Please start." });
    }
  }
  return buildId;
}

/** Marks every unread message of each agent in buildId read. */
async function drain(agents, buildId) {
  for (const agent of agents) await agent.call("inbox", { build_id: buildId, limit: 100 });
}

// =====================================================================================
describe("1. connect, initialize and tools/list for every role", { concurrency: 1 }, () => {
  let relay;
  let version;
  before(async () => {
    relay = await startRelay();
    version = (await http(relay, "/health")).body.version;
  });
  after(async () => {
    await relay?.stop();
  });

  for (const role of ROLES) {
    for (const pathToken of [false, true]) {
      test(`${role} via ${pathToken ? "/mcp/<token> path" : "Authorization header"}`, async () => {
        const agent = await connect(relay, role, { pathToken });
        try {
          const { client } = agent;
          assert.deepEqual(client.getServerVersion(), { name: "agent-relay", version });
          assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: false });
          const instructions = client.getInstructions() ?? "";
          assert.ok(instructions.includes(PROTOCOL.trim()), "instructions contain protocol/PROTOCOL.md");
          assert.ok(instructions.includes(ADDENDA[role].trim()), `instructions contain protocol/roles/${role}.md`);
          for (const other of ROLES.filter((r) => r !== role)) {
            assert.ok(!instructions.includes(ADDENDA[other].trim()), `instructions leave out the ${other} addendum`);
          }

          const { tools } = await client.listTools();
          assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS_BY_ROLE[role]].sort(), `${role} tools`);
          for (const tool of tools) {
            assert.equal(tool.inputSchema?.type, "object", `${tool.name} inputSchema`);
            assert.ok(typeof tool.description === "string" && tool.description.length > 20, `${tool.name} description`);
            assert.equal(tool.annotations?.readOnlyHint, READ_ONLY_TOOLS.has(tool.name), `${tool.name} readOnlyHint`);
          }
          const send = tools.find((t) => t.name === "send");
          assert.deepEqual([...send.inputSchema.required].sort(), ["body", "build_id", "to_role", "type"]);

          const me = await agent.call("whoami");
          assert.equal(me.role, role);
          assert.equal(me.display_name, { orchestrator: "Orchestrator", "creative-director": "Creative Director", developer: "Full-Stack Developer", human: "James" }[role]);
          assert.deepEqual(me.roles.map((r) => r.id), ROLES);
          assertFields(me.roles.find((r) => r.id === "creative-director"), { display_name: "Creative Director" });
          assert.ok(me.roles.find((r) => r.id === "creative-director").aliases.includes("cd"));
          assert.ok(me.roles.find((r) => r.id === "developer").aliases.includes("dev"));
          assert.ok(me.roles.find((r) => r.id === "human").aliases.includes("james"));
          assert.equal(me.halted.global, false);
          assert.equal(me.version, version);
        } finally {
          await agent.close();
        }
      });
    }
  }

  test("JSON-RPC over raw HTTP: version negotiation, notifications, ping, batches, errors", async () => {
    const init = (protocolVersion, id = 1) => ({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    });
    for (const v of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
      const res = await rpc(relay, init(v), { role: "developer" });
      assert.equal(res.status, 200);
      assert.equal(res.body.result.protocolVersion, v, `echoes ${v}`);
    }
    const odd = await rpc(relay, init("1999-01-01"), { role: "developer", pathToken: true });
    assertFields(odd.body.result, { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } });
    assertFields(odd.body.result.serverInfo, { name: "agent-relay" });

    const note = await rpc(relay, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    assert.equal(note.body, null);

    assert.deepEqual((await rpc(relay, { jsonrpc: "2.0", id: 7, method: "ping" })).body, { jsonrpc: "2.0", id: 7, result: {} });
    assert.deepEqual((await rpc(relay, { jsonrpc: "2.0", id: 8, method: "resources/list" })).body.result, { resources: [] });
    assert.deepEqual((await rpc(relay, { jsonrpc: "2.0", id: 9, method: "prompts/list" })).body.result, { prompts: [] });
    assert.equal((await rpc(relay, { jsonrpc: "2.0", id: 10, method: "nope/nope" })).body.error.code, -32601);
    assert.equal((await rpc(relay, { jsonrpc: "2.0", id: 11, method: "tools/call", params: {} })).body.error.code, -32602);
    const parse = await http(relay, "/mcp", { method: "POST", role: "human", headers: { "content-type": "application/json" }, rawBody: "{nope" });
    assert.equal(parse.body.error.code, -32700);

    const batch = await rpc(relay, [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ]);
    assert.equal(batch.status, 200);
    assert.ok(Array.isArray(batch.body), "a batch is answered with an array");
    assert.deepEqual(batch.body.map((r) => r.id), ["a", "b"]);
    assert.equal(batch.body[1].result.tools.length, TOOLS_BY_ROLE.human.length);

    // tools/call result shape (DESIGN §10).
    const call = await rpc(relay, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "whoami", arguments: {} } }, { role: "orchestrator" });
    assert.equal(call.body.result.structuredContent.role, "orchestrator");
    assert.deepEqual(JSON.parse(call.body.result.content[0].text), call.body.result.structuredContent);
    const denied = await rpc(relay, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "kill_switch", arguments: { on: true } } }, { role: "orchestrator" });
    assert.equal(denied.body.result.isError, true);
    assert.match(denied.body.result.content[0].text, /^forbidden: /);
  });

  test("GET and DELETE on /mcp answer 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      assert.equal((await http(relay, "/mcp", { method, role: "human" })).status, 405, `${method} /mcp`);
      assert.equal((await http(relay, `/mcp/${relay.tokens.human}`, { method })).status, 405, `${method} /mcp/<token>`);
    }
  });
});

// =====================================================================================
describe("2. PRD core workflow: kickoff brief to shipped v1", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;
  const step = stepper();
  const nextAudit = auditCursor();
  const msgs = {};
  const ledger = () => human.call("ledger_get", { build_id: buildId });
  const summary = async (include_closed = false) =>
    (await human.call("build_list", { include_closed })).builds.find((b) => b.build_id === buildId);
  const others = (...roles) => [o, cd, dev, human].filter((agent) => !roles.includes(agent.role));

  before(async () => {
    relay = await startRelay();
    // Orchestrator and developer send the Authorization header; creative director and human use /mcp/<token>.
    team = await connectTeam(relay, { pathRoles: ["creative-director", "human"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  step("1 kickoff: human build_create; the brief lands in the orchestrator's inbox as a task message", async () => {
    const build = await human.call("build_create", { title: "Tip calculator", brief: BRIEF });
    assert.match(build.build_id, BUILD_ID);
    buildId = build.build_id;
    assertFields(build, {
      title: "Tip calculator",
      brief: BRIEF,
      status: "planning",
      created_by: "human",
      gates: { plan_approval: true, final_signoff: true },
      caps: { max_messages: 200, max_review_rounds: 3 },
      message_count: 0,
      status_before_halt: null,
      halt_reason: null,
      created_at: ISO,
      updated_at: ISO,
    });

    await assertNoUnread([cd, dev, human], buildId);
    const { messages, entry } = await deliver(
      o,
      buildId,
      [{ from: "human", type: "task", task_id: null, body: BRIEF, on_behalf_of: null, links: [], verdict: null, changes: null, reply_to: null }],
      { sessionRef: "orchestrator-thread" },
    );
    msgs.kickoff = messages[0];
    assertFields(entry, { title: "Tip calculator", status: "planning", my_tasks: [], pending_gates: [] });

    const l = await ledger();
    assert.deepEqual([l.tasks, l.gates, l.verdicts], [[], [], []]);
    assert.deepEqual(l.messages.map((m) => m.id), [msgs.kickoff.id]);
    const thread = l.threads.find((t) => t.role === "orchestrator");
    assertFields(thread, { thread_key: `${buildId}/orchestrator`, session_ref: "orchestrator-thread", last_message_at: ISO, last_polled_at: ISO });
    assertAudit(nextAudit(l), [
      ["human", /build/, buildId],
      ["human", /message/, msgs.kickoff.id],
    ]);

    const s = await summary();
    assertFields(s, { title: "Tip calculator", status: "planning", owners: [], pending_gates: [], updated_at: ISO });
    assertFields(s.last_message, { id: msgs.kickoff.id, from: "human", to: "orchestrator", type: "task", excerpt: BRIEF, created_at: ISO });
  });

  step("2 plan: the orchestrator creates a screen task (CD -> CD) and a ship task (developer -> CD)", async () => {
    const { task: t1 } = await o.call("ledger_update", {
      build_id: buildId,
      title: "Calculator screen",
      description: "Acceptance: 1. bill, tip and split inputs; 2. live per-person total; 3. 4.5:1 contrast.",
      assignee: "creative-director",
      reviewer: "creative-director",
    });
    assertFields(t1, {
      id: "T1",
      assignee: "creative-director",
      owner: "creative-director",
      reviewer: "creative-director",
      status: "todo",
      round: 0,
      max_rounds: 3,
      artifacts: [],
      notes: [],
      depends_on: [],
      nudge_count: 0,
      last_nudge_at: null,
      stalled: false,
      escalated: false,
      last_activity_at: ISO,
      created_at: ISO,
      updated_at: ISO,
    });
    const { task: t2 } = await o.call("ledger_update", {
      build_id: buildId,
      title: "Ship v1",
      description: "Production deploy of the approved commit, reviewed on the production URL.",
      assignee: "dev",
      reviewer: "cd",
      depends_on: ["T1"],
    });
    assertFields(t2, { id: "T2", assignee: "developer", owner: "developer", reviewer: "creative-director", status: "todo", depends_on: ["T1"] });

    // Planning: agents may not send work messages, and only the orchestrator or the human creates tasks.
    await o.fails("send", { build_id: buildId, to_role: "creative-director", type: "task", task_id: "T1", body: "Start" }, "conflict");
    await cd.fails("ledger_update", { build_id: buildId, title: "Rogue task", assignee: "developer" }, "forbidden");

    await assertNoUnread([o, cd, dev, human], buildId);
    const l = await ledger();
    assert.deepEqual(l.tasks.map((t) => t.id), ["T1", "T2"]);
    assertAudit(nextAudit(l), [
      ["orchestrator", /task/, "T1"],
      ["orchestrator", /task/, "T2"],
    ]);
    assert.deepEqual(owners(await summary()), [
      { task_id: "T1", owner: "creative-director" },
      { task_id: "T2", owner: "developer" },
    ]);
  });

  const PLAN = "T1 Calculator screen (creative-director -> creative-director), then T2 Ship v1 (developer -> creative-director). Assumes no backend.";

  step("3 gate_request plan_approval: the human sees it in the inbox, the ledger and build_list", async () => {
    const { gate, build } = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: PLAN });
    assertFields(gate, {
      id: "G1",
      kind: "plan_approval",
      status: "pending",
      task_id: null,
      summary: PLAN,
      auto: false,
      requested_by: "orchestrator",
      requested_at: ISO,
      decided_by: null,
      decided_at: null,
    });
    assert.equal(build.status, "awaiting_plan_approval");
    await o.fails("gate_request", { build_id: buildId, kind: "plan_approval", summary: PLAN }, "conflict");
    await o.fails("gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved" }, "forbidden");

    await assertNoUnread([o, cd, dev], buildId);
    const { messages, entry } = await deliver(human, buildId, [{ from: "relay", type: "question", on_behalf_of: "orchestrator", body: /G1/ }], {
      sessionRef: "james-phone",
    });
    msgs.planGate = messages[0];
    assert.ok(msgs.planGate.body.includes(PLAN), "the gate notice carries the plan summary");
    assert.deepEqual(entry.pending_gates.map((g) => [g.id, g.kind, g.status]), [["G1", "plan_approval", "pending"]]);

    const l = await ledger();
    assert.equal(l.build.status, "awaiting_plan_approval");
    assert.deepEqual(l.gates.map((g) => [g.id, g.status]), [["G1", "pending"]]);
    assertAudit(nextAudit(l), [
      ["orchestrator", /gate/, "G1"],
      ["relay", /message/, msgs.planGate.id],
    ]);
    const s = await summary();
    assert.equal(s.status, "awaiting_plan_approval");
    assert.deepEqual(s.pending_gates.map((g) => g.id), ["G1"]);
    assertFields(s.last_message, { id: msgs.planGate.id, from: "relay", to: "human", type: "question" });
  });

  step("4 human approves the plan: build in_progress, the orchestrator is told", async () => {
    const { gate, build } = await human.call("gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved", note: "Looks good" });
    assertFields(gate, { status: "approved", decided_by: "human", decided_at: ISO, note: "Looks good" });
    assert.equal(build.status, "in_progress");
    await human.fails("gate_decide", { build_id: buildId, gate_id: "G1", decision: "rejected" }, "conflict");

    await assertNoUnread([cd, dev, human], buildId);
    const { messages } = await deliver(o, buildId, [{ from: "human", body: /G1/ }]);
    assert.ok(messages[0].body.includes("Looks good"), "the decision message carries the note");

    const l = await ledger();
    assertAudit(nextAudit(l), [
      ["human", /gate/, "G1"],
      ["human", /message/, messages[0].id],
    ]);
    const s = await summary();
    assertFields(s, { status: "in_progress", pending_gates: [] });
  });

  step("5 the orchestrator assigns T1 to the creative director, who starts it", async () => {
    const { message, task } = await o.call("send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "task",
      task_id: "T1",
      body: "Design the calculator screen. Acceptance criteria are in T1.",
    });
    assertFields(message, {
      from: "orchestrator",
      to: "creative-director",
      type: "task",
      task_id: "T1",
      verdict: null,
      changes: null,
      reply_to: null,
      on_behalf_of: null,
      read_at: null,
      build_id: buildId,
    });
    assertFields(task, { assignee: "creative-director", owner: "creative-director", status: "todo" });

    await assertNoUnread([o, dev, human], buildId);
    const { entry } = await deliver(cd, buildId, [{ id: message.id, from: "orchestrator", type: "task", task_id: "T1" }], { sessionRef: "cd-thread" });
    assert.deepEqual(entry.my_tasks.map((t) => t.id), ["T1"]);

    const started = await cd.call("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" });
    assertFields(started.task, { status: "in_progress", owner: "creative-director" });
    await cd.fails("ledger_update", { build_id: buildId, task_id: "T1", assignee: "developer" }, "forbidden");
    await dev.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" }, "forbidden");

    const l = await ledger();
    assert.equal(l.build.message_count, 1);
    assertAudit(nextAudit(l), [
      ["orchestrator", /message/, message.id],
      ["creative-director", /task/, "T1"],
    ]);
    assert.deepEqual(owners(await summary()), [
      { task_id: "T1", owner: "creative-director" },
      { task_id: "T2", owner: "developer" },
    ]);
  });

  step("6 the creative director hands T1 off to the developer with the spec link", async () => {
    const { message, task } = await cd.call("send", {
      build_id: buildId,
      to_role: "developer",
      type: "handoff",
      task_id: "T1",
      body: "Spec ready: tokens and acceptance checklist inside.",
      links: [SPEC],
    });
    assertFields(message, { from: "creative-director", to: "developer", type: "handoff", links: [SPEC] });
    assertFields(task, { assignee: "developer", owner: "developer", status: "todo", artifacts: [SPEC] });

    await assertNoUnread([o, cd, human], buildId);
    const { entry } = await deliver(dev, buildId, [{ id: message.id, from: "creative-director", type: "handoff", links: [SPEC] }], {
      sessionRef: "dev-thread",
    });
    assert.deepEqual(entry.my_tasks.map((t) => t.id), ["T1", "T2"]);

    await cd.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" }, "forbidden");
    const { task: building } = await dev.call("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress", note: "Building from the spec" });
    assertFields(building, { status: "in_progress" });
    assertFields(building.notes.at(-1), { by: "developer", text: "Building from the spec", at: ISO });

    const l = await ledger();
    assertAudit(nextAudit(l), [
      ["creative-director", /message/, message.id],
      ["creative-director", /task/, "T1"],
      ["developer", /task/, "T1"],
    ]);
    assertFields((await summary()).last_message, { id: message.id, from: "creative-director", to: "developer", type: "handoff" });
  });

  step("7 the developer requests review (round 1) with the preview link", async () => {
    await dev.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "done" }, "forbidden");
    await dev.fails("send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "No link" }, "invalid_input");
    const { message, task } = await dev.call("send", {
      build_id: buildId,
      to_role: "cd",
      type: "review_request",
      task_id: "T1",
      body: "Round 1 at 1a2b3c4: all three screens states.",
      links: [PREVIEW_1, COMMIT_1],
    });
    assertFields(message, { from: "developer", to: "creative-director", type: "review_request", links: [PREVIEW_1, COMMIT_1] });
    assertFields(task, { round: 1, reviewer: "creative-director", owner: "creative-director", status: "in_review", artifacts: [SPEC, PREVIEW_1, COMMIT_1] });
    await dev.fails("send", { build_id: buildId, to_role: "orchestrator", type: "handoff", task_id: "T1", body: "Take it", links: [SPEC] }, "forbidden");

    await assertNoUnread([o, dev, human], buildId);
    await deliver(cd, buildId, [{ id: message.id, from: "developer", type: "review_request", task_id: "T1" }]);
    const l = await ledger();
    assertAudit(nextAudit(l), [
      ["developer", /message/, message.id],
      ["developer", /task/, "T1"],
    ]);
    assert.deepEqual(owners(await summary())[0], { task_id: "T1", owner: "creative-director" });
  });

  step("8 the creative director requests changes: the task goes back to the developer", async () => {
    await cd.fails("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "changes_requested", body: "Fix" }, "invalid_input");
    await dev.fails("send", { build_id: buildId, to_role: "creative-director", type: "verdict", task_id: "T1", verdict: "approved", body: "LGTM" }, "forbidden");
    const { message, task } = await cd.call("send", {
      build_id: buildId,
      to_role: "developer",
      type: "verdict",
      task_id: "T1",
      verdict: "changes_requested",
      changes: CHANGES,
      body: "Two misses against the spec.",
    });
    msgs.verdict1 = message;
    assertFields(message, { type: "verdict", verdict: "changes_requested", changes: CHANGES });
    assertFields(task, { status: "changes_requested", owner: "developer", assignee: "developer", round: 1 });
    await cd.fails("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "approved", body: "Again" }, "conflict");

    await assertNoUnread([o, cd, human], buildId);
    await deliver(dev, buildId, [{ id: message.id, from: "creative-director", type: "verdict", verdict: "changes_requested", changes: CHANGES }]);
    const l = await ledger();
    assert.deepEqual(l.verdicts, [
      { id: "V1", task_id: "T1", round: 1, verdict: "changes_requested", changes: CHANGES, reviewer: "creative-director", message_id: message.id, created_at: l.verdicts[0].created_at },
    ]);
    assertAudit(nextAudit(l), [
      ["creative-director", /message/, message.id],
      ["creative-director", /task/, "T1"],
    ]);
    assert.deepEqual(owners(await summary())[0], { task_id: "T1", owner: "developer" });
  });

  step("9 the developer answers every change and requests review (round 2)", async () => {
    await dev.call("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" });
    const { message, task } = await dev.call("send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "review_request",
      task_id: "T1",
      body: "Round 2 at 5d6e7f8.\n1. Done: header 20px/600.\n2. Done: 44px buttons.",
      links: [PREVIEW_2, COMMIT_2],
      reply_to: msgs.verdict1.id,
    });
    assertFields(message, { reply_to: msgs.verdict1.id, type: "review_request" });
    assertFields(task, { round: 2, status: "in_review", owner: "creative-director", artifacts: [SPEC, PREVIEW_1, COMMIT_1, PREVIEW_2, COMMIT_2] });
    await assertNoUnread([o, dev, human], buildId);
    await deliver(cd, buildId, [{ id: message.id, from: "developer", type: "review_request", reply_to: msgs.verdict1.id }]);

    // since: every message to the developer after seq N, read or not; peek leaves read state alone.
    const all = entryFor(await dev.call("inbox", { build_id: buildId, since: 0, peek: true }), buildId);
    assert.deepEqual(all.messages.map((m) => m.type), ["handoff", "verdict"]);
    assert.ok(all.messages.every((m) => m.read_at !== null), "since returns already-read messages too");
    const later = entryFor(await dev.call("inbox", { build_id: buildId, since: all.messages[0].seq, peek: true }), buildId);
    assert.deepEqual(later.messages.map((m) => m.id), [msgs.verdict1.id]);
    // Without build_id, since is ignored: only unread messages come back.
    const across = await dev.call("inbox", { since: 0, peek: true });
    assert.deepEqual(entryFor(across, buildId).messages, []);
    assertAudit(nextAudit(await ledger()), [["developer", /message/, message.id]]);
  });

  step("10 the creative director approves round 2: T1 is done", async () => {
    const { message, task } = await cd.call("send", {
      build_id: buildId,
      to_role: "developer",
      type: "verdict",
      task_id: "T1",
      verdict: "approved",
      body: "Meets the spec.",
    });
    assertFields(task, { status: "done", owner: null, round: 2 });
    await assertNoUnread([cd, human], buildId);
    const { entry } = await deliver(dev, buildId, [{ id: message.id, from: "creative-director", type: "verdict", verdict: "approved" }]);
    assert.deepEqual(entry.my_tasks.map((t) => t.id), ["T2"]);
    // A done task is closed (DESIGN §6: review_request is rejected on done tasks); it also has no owner any more.
    await dev.failsAny("send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "Again", links: [PREVIEW_2] }, ["conflict", "forbidden"]);

    const l = await ledger();
    assert.deepEqual(l.verdicts.map((v) => [v.id, v.round, v.verdict, v.changes]), [
      ["V1", 1, "changes_requested", CHANGES],
      ["V2", 2, "approved", null],
    ]);
    assertAudit(nextAudit(l), [
      ["creative-director", /message/, message.id],
      ["creative-director", /task/, "T1"],
    ]);
    assert.deepEqual(owners(await summary()), [{ task_id: "T2", owner: "developer" }]);
  });

  step("11 ship task T2: assigned, reviewed on the production URL, approved", async () => {
    const assign = await o.call("send", { build_id: buildId, to_role: "developer", type: "task", task_id: "T2", body: "T1 approved: deploy production." });
    await deliver(dev, buildId, [{ id: assign.message.id, from: "orchestrator", type: "task", task_id: "T2" }]);
    await dev.call("ledger_update", { build_id: buildId, task_id: "T2", status: "in_progress" });
    const rr = await dev.call("send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "review_request",
      task_id: "T2",
      body: "Production deployed from 5d6e7f8.",
      links: [PRODUCTION, COMMIT_2],
    });
    assertFields(rr.task, { round: 1, status: "in_review", owner: "creative-director" });
    await deliver(cd, buildId, [{ id: rr.message.id, from: "developer", type: "review_request", task_id: "T2" }]);
    const ok = await cd.call("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T2", verdict: "approved", body: "Production OK." });
    assertFields(ok.task, { status: "done", owner: null });
    await deliver(dev, buildId, [{ id: ok.message.id, from: "creative-director", type: "verdict", verdict: "approved" }]);
    await assertNoUnread([human], buildId);

    const l = await ledger();
    assert.ok(l.tasks.every((t) => t.status === "done"));
    assert.equal(l.build.message_count, 9, "nine agent messages so far (human and relay messages do not count)");
    assertAudit(nextAudit(l), [
      ["orchestrator", /message/, assign.message.id],
      ["developer", /message/, rr.message.id],
      ["creative-director", /message/, ok.message.id],
    ]);
    const s = await summary();
    assertFields(s, { owners: [], pending_gates: [] });
    assertFields(s.last_message, { id: ok.message.id, from: "creative-director", to: "developer", type: "verdict" });
  });

  step("12 gate_request final_signoff: the human sees it with the production links", async () => {
    await drain([o], buildId); // whatever told the orchestrator that every task is closed
    const { gate, build } = await o.call("gate_request", {
      build_id: buildId,
      kind: "final_signoff",
      summary: "Tip calculator v1 is live.",
      links: [PRODUCTION, REPO_LINK],
    });
    assertFields(gate, { id: "G2", kind: "final_signoff", status: "pending", links: [PRODUCTION, REPO_LINK] });
    assert.equal(build.status, "awaiting_signoff");
    await o.fails("send", { build_id: buildId, to_role: "developer", type: "task", task_id: "T2", body: "More" }, "conflict");

    await assertNoUnread([o, cd, dev], buildId);
    const { messages, entry } = await deliver(human, buildId, [
      { from: "relay", type: "question", on_behalf_of: "orchestrator", links: [PRODUCTION, REPO_LINK], body: /G2/ },
    ]);
    assert.deepEqual(entry.pending_gates.map((g) => g.id), ["G2"]);
    const s = await summary();
    assertFields(s, { status: "awaiting_signoff", owners: [] });
    assert.deepEqual(s.pending_gates.map((g) => g.id), ["G2"]);
    assertAudit(nextAudit(await ledger()), [
      ["orchestrator", /gate/, "G2"],
      ["relay", /message/, messages[0].id],
    ]);
  });

  step("13 human signs off: the build is shipped and leaves the active list", async () => {
    const { gate, build } = await human.call("gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" });
    assertFields(gate, { status: "approved", decided_by: "human" });
    assert.equal(build.status, "shipped");
    await assertNoUnread([cd, dev, human], buildId);
    const { messages } = await deliver(o, buildId, [{ from: "human", body: /G2/ }]);

    assert.equal(await summary(false), undefined, "build_list leaves shipped builds out by default");
    const closed = await summary(true);
    assertFields(closed, { status: "shipped", owners: [], pending_gates: [] });
    assertFields(closed.last_message, { id: messages[0].id, from: "human", to: "orchestrator" });
    const across = await o.call("inbox", {});
    assert.ok(!across.builds.some((b) => b.build_id === buildId), "inbox without build_id covers only open builds");

    await o.fails("send", { build_id: buildId, to_role: "developer", type: "status", body: "Done?" }, "conflict");
    await dev.fails("ledger_update", { build_id: buildId, task_id: "T2", note: "late" }, "conflict");

    const l = await ledger();
    assertFields(l.build, { status: "shipped", message_count: 9 });
    assert.equal(l.messages.filter((m) => m.from !== "relay").length, 12, "kickoff + 9 agent messages + 2 gate decisions");
    assert.deepEqual(
      l.messages.filter((m) => m.from === "relay" && m.to === "human").map((m) => m.type),
      ["question", "question"],
      "the human got exactly the two gate notices",
    );
    assert.deepEqual(l.gates.map((g) => [g.id, g.kind, g.status]), [
      ["G1", "plan_approval", "approved"],
      ["G2", "final_signoff", "approved"],
    ]);
    // Presence: every role has a thread row, polled from the session it named.
    const threads = Object.fromEntries(l.threads.map((t) => [t.role, t]));
    assert.deepEqual(Object.keys(threads).sort(), [...ROLES].sort());
    for (const role of ROLES) {
      assertFields(threads[role], { thread_key: `${buildId}/${role}`, created_at: ISO, last_message_at: ISO, last_polled_at: ISO });
    }
    assert.deepEqual(
      ROLES.map((r) => threads[r].session_ref),
      ["orchestrator-thread", "cd-thread", "dev-thread", "james-phone"],
    );
    assertAudit(nextAudit(l), [
      ["human", /gate/, "G2"],
      ["human", /message/, messages[0].id],
    ]);
    // Human touchpoints: kickoff plus two gate decisions.
    assert.equal(l.messages.filter((m) => m.from === "human").length, 3);

    // The one active-build slot is free again.
    const next = await human.call("build_create", { title: "Next", brief: "Another app." });
    assert.equal(next.status, "planning");
  });
});

// =====================================================================================
describe("3. review cap escalation", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;
  let gateId;
  const step = stepper();

  const requestReview = (round) =>
    dev.call("send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "review_request",
      task_id: "T1",
      body: `Round ${round}`,
      links: [{ url: `https://tip-calc-r${round}.pages.dev/`, label: "Preview" }],
    });
  const requestChanges = (round) =>
    cd.call("send", {
      build_id: buildId,
      to_role: "developer",
      type: "verdict",
      task_id: "T1",
      verdict: "changes_requested",
      changes: [`Round ${round}: header still 16px`],
      body: `Round ${round} verdict`,
    });

  before(async () => {
    relay = await startRelay();
    team = await connectTeam(relay, { pathRoles: ["developer"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  step("rounds 1 and 2 of changes_requested keep the loop going", async () => {
    buildId = await startBuild(team);
    await drain([o, cd, dev, human], buildId);
    for (const round of [1, 2]) {
      const rr = await requestReview(round);
      assertFields(rr.task, { round, status: "in_review", owner: "creative-director" });
      const v = await requestChanges(round);
      assertFields(v.task, { round, status: "changes_requested", owner: "developer", escalated: false });
    }
    await drain([cd, dev], buildId);
    await assertNoUnread([o, human], buildId);
  });

  step("round 3 changes_requested escalates: blocked, owner human, escalation gate, relay messages to human and orchestrator", async () => {
    await requestReview(3);
    await drain([cd], buildId);
    const v = await requestChanges(3);
    assertFields(v.task, { round: 3, max_rounds: 3, status: "blocked", escalated: true, owner: "human", assignee: "developer" });

    const l = await human.call("ledger_get", { build_id: buildId });
    const gate = l.gates.find((g) => g.kind === "escalation");
    assertFields(gate, { status: "pending", task_id: "T1", requested_by: "relay", auto: false });
    gateId = gate.id;
    assert.deepEqual(l.verdicts.map((x) => [x.round, x.verdict]), [
      [1, "changes_requested"],
      [2, "changes_requested"],
      [3, "changes_requested"],
    ]);
    assertAudit(l.audit, [["relay", /escalat/, "T1"]]);

    const toHuman = await deliver(human, buildId, [{ from: "relay", task_id: "T1", body: new RegExp(gateId) }]);
    assert.ok(toHuman.messages[0].body.includes("Round 3: header still 16px"), "the escalation lists the open changes");
    assert.deepEqual(toHuman.entry.my_tasks.map((t) => t.id), ["T1"]);
    assert.deepEqual(toHuman.entry.pending_gates.map((g) => g.id), [gateId]);
    await deliver(o, buildId, [{ from: "relay", task_id: "T1" }]);
    await deliver(dev, buildId, [{ from: "creative-director", type: "verdict", verdict: "changes_requested" }]);
    await assertNoUnread([cd], buildId);

    // The loop is stopped until the human decides.
    await dev.failsAny(
      "send",
      { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "Round 4", links: [PREVIEW_2] },
      ["conflict", "forbidden"],
    );
    await dev.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" }, "forbidden");
    await cd.fails("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "approved", body: "ok" }, "conflict");

    const s = (await human.call("build_list", {})).builds.find((b) => b.build_id === buildId);
    assert.deepEqual(owners(s), [{ task_id: "T1", owner: "human" }]);
    assert.deepEqual(s.pending_gates.map((g) => [g.id, g.kind]), [[gateId, "escalation"]]);
  });

  step("the human grants extra_rounds=1: round 4 is allowed and an approval closes the task", async () => {
    const res = await human.call("gate_decide", { build_id: buildId, gate_id: gateId, decision: "approved", extra_rounds: 1 });
    assertFields(res.gate, { status: "approved", extra_rounds: 1, decided_by: "human" });
    assertFields(res.task, { max_rounds: 4, status: "changes_requested", owner: "developer", escalated: false });
    await deliver(o, buildId, [{ from: "human", task_id: "T1" }]);
    await deliver(dev, buildId, [{ from: "human", task_id: "T1" }]);
    await assertNoUnread([cd, human], buildId);

    const rr = await requestReview(4);
    assertFields(rr.task, { round: 4, status: "in_review" });
    const ok = await cd.call("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "approved", body: "Finally." });
    assertFields(ok.task, { status: "done", owner: null, round: 4 });
  });

  step("variant: a rejected escalation leaves the task blocked with the orchestrator", async () => {
    await human.call("build_control", { build_id: buildId, action: "cancel", reason: "next variant" });
    buildId = await startBuild(team, { caps: { max_review_rounds: 1 } });
    await drain([o, cd, dev, human], buildId);
    await requestReview(1);
    await drain([cd], buildId);
    const v = await requestChanges(1);
    assertFields(v.task, { round: 1, max_rounds: 1, status: "blocked", escalated: true, owner: "human" });
    const gate = (await human.call("ledger_get", { build_id: buildId })).gates.find((g) => g.kind === "escalation");
    await deliver(human, buildId, [{ from: "relay", task_id: "T1", body: new RegExp(gate.id) }]);

    const res = await human.call("gate_decide", { build_id: buildId, gate_id: gate.id, decision: "rejected", note: "Cut the scope" });
    assertFields(res.gate, { status: "rejected", note: "Cut the scope" });
    assertFields(res.task, { status: "blocked", owner: "orchestrator", max_rounds: 1 });
    const toOrch = await deliver(o, buildId, [{ from: "relay", task_id: "T1" }, { from: "human", task_id: "T1" }]);
    assert.ok(toOrch.messages[1].body.includes("Cut the scope"));
    await deliver(dev, buildId, [{ from: "creative-director", type: "verdict" }, { from: "human", task_id: "T1" }]);
    await assertNoUnread([cd, human], buildId);
    assert.deepEqual(owners((await human.call("build_list", {})).builds[0]), [{ task_id: "T1", owner: "orchestrator" }]);

    // The orchestrator re-plans: cancel the task (protocol/roles/orchestrator.md).
    await dev.failsAny("send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "r2", links: [PREVIEW_2] }, ["conflict", "forbidden"]);
    const { task } = await o.call("ledger_update", { build_id: buildId, task_id: "T1", status: "cancelled", note: "Rejected at escalation" });
    assertFields(task, { status: "cancelled", owner: null });
  });
});

// =====================================================================================
describe("4. nudges with real alarms (NUDGE_AFTER_MINUTES=0.05, i.e. 3 s)", { concurrency: 1 }, () => {
  const AFTER = 3_000;
  const SLACK = 100; // alarm/clock skew tolerated when comparing timestamps
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;
  const step = stepper();
  let firstNudge;
  let escalationAt;

  const ledgerTask = async () => taskIn(await human.call("ledger_get", { build_id: buildId }), "T1");
  /** Relay messages about T1 to `agent`, peeked (no side effects). */
  const relayNotes = async (agent) =>
    entryFor(await agent.call("inbox", { build_id: buildId, since: 0, peek: true, limit: 100 }), buildId).messages.filter(
      (m) => m.from === "relay" && m.task_id === "T1",
    );
  const waitRelayNote = (agent, after, match) =>
    waitFor(
      async () => (await relayNotes(agent)).find((m) => Date.parse(m.created_at) > after && (!match || match.test(m.body))),
      { timeout: 6 * AFTER, message: `a relay message about T1 to ${agent.role}` },
    );

  before(async () => {
    relay = await startRelay({ vars: { NUDGE_AFTER_MINUTES: "0.05" } });
    team = await connectTeam(relay, { pathRoles: ["orchestrator"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  step("an idle owner gets a relay nudge on behalf of the orchestrator, and the orchestrator a copy", async () => {
    buildId = await startBuild(team);
    const task = await ledgerTask();
    assertFields(task, { owner: "developer", nudge_count: 0, stalled: false });
    const idleSince = Date.parse(task.last_activity_at);

    firstNudge = await waitRelayNote(dev, 0);
    assertFields(firstNudge, { to: "developer", type: "status", on_behalf_of: "orchestrator", task_id: "T1", body: /^Nudge: T1 "Calculator screen" has been idle for / });
    assert.ok(Date.parse(firstNudge.created_at) - idleSince >= AFTER - SLACK, "the nudge waits NUDGE_AFTER_MINUTES");
    const copy = await waitRelayNote(o, 0);
    assertFields(copy, { to: "orchestrator", task_id: "T1", body: /developer/ });

    const nudged = await ledgerTask();
    assertFields(nudged, { nudge_count: 1, stalled: false, last_nudge_at: ISO });
    const early = (await relayNotes(human)).filter((m) => Date.parse(m.created_at) - Date.parse(firstNudge.created_at) < AFTER - SLACK);
    assert.deepEqual(early, [], "the human hears nothing before the second miss");
    assertAudit((await human.call("ledger_get", { build_id: buildId })).audit, [["relay", /nudge/, "T1"]]);
  });

  step("a second miss escalates to the human and the orchestrator and marks the task stalled", async () => {
    const esc = await waitRelayNote(human, 0, /missed two nudges/);
    assertFields(esc, { to: "human", task_id: "T1", on_behalf_of: "orchestrator" });
    escalationAt = Date.parse(esc.created_at);
    assert.ok(escalationAt - Date.parse(firstNudge.created_at) >= AFTER - SLACK, "the escalation waits another interval");
    await waitRelayNote(o, 0, /missed two nudges/);
    assertFields(await ledgerTask(), { nudge_count: 2, stalled: true });
  });

  step("no further nudges until there is activity", async () => {
    await sleep(AFTER + 1_500);
    for (const agent of [dev, o, human]) {
      const late = (await relayNotes(agent)).filter((m) => Date.parse(m.created_at) > escalationAt);
      assert.deepEqual(late.map((m) => m.body), [], `${agent.role} gets nothing after the escalation`);
    }
    assertFields(await ledgerTask(), { nudge_count: 2, stalled: true });
  });

  step("activity by the owner (ledger_update, then a message) resets the nudge state and restarts the clock", async () => {
    const { task } = await dev.call("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" });
    assertFields(task, { nudge_count: 0, stalled: false, last_nudge_at: null });
    const resetAt = Date.parse(task.last_activity_at);
    assert.ok(resetAt > escalationAt);

    const next = await waitRelayNote(dev, resetAt, /^Nudge: T1/);
    assert.ok(Date.parse(next.created_at) - resetAt >= AFTER - SLACK, "the new nudge counts from the activity");
    assertFields(await ledgerTask(), { nudge_count: 1 });

    const { task: viaMessage } = await dev.call("send", { build_id: buildId, to_role: "orchestrator", type: "status", task_id: "T1", body: "Header done, buttons next." });
    assertFields(viaMessage, { nudge_count: 0, stalled: false, last_nudge_at: null });
  });

  step("an ownership change moves the nudges to the new owner", async () => {
    const rr = await dev.call("send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "review_request",
      task_id: "T1",
      body: "Round 1",
      links: [PREVIEW_1],
    });
    const handedAt = Date.parse(rr.task.last_activity_at);
    assertFields(rr.task, { owner: "creative-director", nudge_count: 0 });
    const toCd = await waitRelayNote(cd, handedAt, /^Nudge: T1/);
    assertFields(toCd, { on_behalf_of: "orchestrator", to: "creative-director" });
    assert.ok(Date.parse(toCd.created_at) - handedAt >= AFTER - SLACK);
    await waitRelayNote(o, handedAt, /creative-director/);
    const devLate = (await relayNotes(dev)).filter((m) => Date.parse(m.created_at) > handedAt);
    assert.deepEqual(devLate, [], "the previous owner is no longer nudged");
  });

  step("the kill switch pauses nudges; turning it off restarts the idle clock", async () => {
    const { task } = await cd.call("ledger_update", { build_id: buildId, task_id: "T1", note: "Reviewing on mobile now" });
    assertFields(task, { nudge_count: 0, status: "in_review" });
    const onAt = Date.now();
    await human.call("kill_switch", { on: true, reason: "pause nudges" });
    await sleep(2 * AFTER + 1_000);
    for (const agent of [cd, o, human]) {
      const during = (await relayNotes(agent)).filter((m) => Date.parse(m.created_at) >= onAt);
      assert.deepEqual(during.map((m) => m.body), [], `no nudges to ${agent.role} while the kill switch is on`);
    }
    assertFields(await ledgerTask(), { nudge_count: 0 });
    const offAt = Date.now();
    await human.call("kill_switch", { on: false });
    const resumed = await waitRelayNote(cd, offAt, /^Nudge: T1/);
    assert.ok(Date.parse(resumed.created_at) - offAt >= AFTER - SLACK, "idle time under the kill switch does not count");
  });

  // PRD: the orchestrator requests final sign-off when every task is closed, and a role acts only when its inbox
  // has something (the inbox Mod wakes a session on unread messages). An approved verdict goes to its to_role only,
  // so the relay itself must get word to the orchestrator: a notice right away or, at the latest, a nudge.
  test("when the last open task closes, the orchestrator hears about it (it owns the next step: final sign-off)", async () => {
    await human.call("build_control", { build_id: buildId, action: "cancel" });
    const id = await startBuild(team, { tasks: [{ title: "Ship v1", assignee: "developer", reviewer: "creative-director" }] });
    await dev.call("send", { build_id: id, to_role: "creative-director", type: "review_request", task_id: "T1", body: "Production", links: [PRODUCTION] });
    await drain([o, cd, dev, human], id);
    const approved = await cd.call("send", { build_id: id, to_role: "developer", type: "verdict", task_id: "T1", verdict: "approved", body: "Ship it." });
    assertFields(approved.task, { status: "done", owner: null });
    assert.equal(approved.message.to, "developer");
    const closedAt = Date.parse(approved.message.created_at);
    const notice = await waitFor(
      async () => entryFor(await o.call("inbox", { build_id: id, peek: true }), id).messages.find((m) => Date.parse(m.created_at) >= closedAt),
      { timeout: 3 * AFTER, message: "any unread message for the orchestrator within 3 nudge intervals after the last task of an in_progress build closed" },
    );
    assert.ok(notice);
  });
});

// =====================================================================================
describe("5. loop safety: message cap, burst limit, kill switch, build_control", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;
  const step = stepper();
  const status = (to_role, body) => ({ build_id: buildId, to_role, type: "status", body });

  before(async () => {
    relay = await startRelay({ vars: { BURST_PER_MINUTE: "4" } });
    team = await connectTeam(relay, { pathRoles: ["creative-director"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  step("message cap: the agent message over caps.max_messages is refused with cap_reached, the build halts, the human is told", async () => {
    buildId = await startBuild(team, { caps: { max_messages: 3 } }); // the task message is agent message 1
    await drain([o, cd, dev, human], buildId);
    await dev.call("send", { ...status("creative-director", "Question on spacing?"), type: "question" }); // 2
    await cd.call("send", status("developer", "8px grid.")); // 3
    await human.call("send", status("orchestrator", "Human messages do not count.")); // not counted
    let l = await human.call("ledger_get", { build_id: buildId });
    assertFields(l.build, { message_count: 3, status: "in_progress" });

    const over = await relay.call("developer", "send", status("orchestrator", "One too many"));
    assert.equal(over.status, 429);
    assertFields(over, { ok: false });
    assert.equal(over.error.code, "cap_reached");

    l = await human.call("ledger_get", { build_id: buildId });
    assertFields(l.build, { status: "halted", halt_reason: "message cap reached", status_before_halt: "in_progress", message_count: 3 });
    assert.ok(!l.messages.some((m) => m.body === "One too many"), "the refused message is not stored");
    assertAudit(l.audit, [["relay", /halt/, buildId]]);
    await deliver(human, buildId, [{ from: "relay", body: /cap/ }]);

    const halted = await relay.call("developer", "send", status("orchestrator", "Still there?"));
    assert.deepEqual([halted.status, halted.error.code], [423, "halted"]);
    await o.fails("ledger_update", { build_id: buildId, task_id: "T1", note: "x" }, "halted");
    assert.equal(entryFor(await dev.call("inbox", { build_id: buildId }), buildId).status, "halted");
    await human.call("send", status("developer", "Hold on, raising the cap."));

    const capped = await human.call("build_control", { build_id: buildId, action: "set_caps", caps: { max_messages: 10 } });
    assertFields(capped.build, { status: "halted", caps: { max_messages: 10, max_review_rounds: 3 } });
    const resumed = await human.call("build_control", { build_id: buildId, action: "resume" });
    assertFields(resumed.build, { status: "in_progress", halt_reason: null });
    await dev.call("send", status("orchestrator", "Resumed."));
    assert.equal((await human.call("ledger_get", { build_id: buildId })).build.message_count, 4);
  });

  step("burst limit: message BURST_PER_MINUTE+1 from one sender within 60 s is rate_limited, without halting", async () => {
    await human.call("build_control", { build_id: buildId, action: "cancel" });
    const build = await human.call("build_create", { title: "Burst", brief: BRIEF });
    buildId = build.build_id;
    for (let i = 1; i <= 4; i += 1) await dev.call("send", status("orchestrator", `Planning note ${i}`));
    const fifth = await relay.call("developer", "send", status("orchestrator", "Planning note 5"));
    assert.deepEqual([fifth.status, fifth.error?.code], [429, "rate_limited"]);
    const viaMcp = await dev.fails("send", status("orchestrator", "Planning note 6"), "rate_limited");
    assert.ok(viaMcp.message.length > 0);
    await cd.call("send", status("orchestrator", "Another sender is unaffected."));
    const l = await human.call("ledger_get", { build_id: buildId });
    assertFields(l.build, { status: "planning", message_count: 5, halt_reason: null });
  });

  step("kill switch on: every agent write fails with halted, inbox reports it, the human keeps working", async () => {
    const { halted } = await human.call("kill_switch", { on: true, reason: "runaway loop" });
    assertFields(halted, { global: true, reason: "runaway loop", at: ISO });
    assert.equal((await dev.call("whoami")).halted.global, true);

    await cd.fails("send", status("orchestrator", "hello"), "halted");
    await o.fails("ledger_update", { build_id: buildId, title: "New task", assignee: "developer" }, "halted");
    await o.fails("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan" }, "halted");
    await o.fails("build_create", { title: "Other", brief: "Other" }, "halted");
    const api = await relay.call("orchestrator", "send", status("developer", "via API"));
    assert.deepEqual([api.status, api.error.code], [423, "halted"]);

    const inbox = await cd.call("inbox", {});
    assertFields(inbox.halted, { global: true, reason: "runaway loop" });
    assert.ok(inbox.builds.some((b) => b.build_id === buildId), "inbox still answers");
    await dev.call("ledger_get", { build_id: buildId });
    await dev.call("build_list", {});

    await human.call("send", status("orchestrator", "I am still here."));
    const { task } = await human.call("ledger_update", { build_id: buildId, title: "Human task", assignee: "developer" });
    assert.equal(task.id, "T1");

    const off = await human.call("kill_switch", { on: false });
    assert.equal(off.halted.global, false);
    assert.equal((await cd.call("inbox", {})).halted.global, false);
    await o.call("send", status("developer", "Back to work."));
    await o.call("ledger_update", { build_id: buildId, task_id: "T1", reviewer: "creative-director" });
  });

  step("build_control: halt / resume / cancel", async () => {
    const { gate } = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan: T1." });
    assert.equal(gate.status, "pending");

    const { build: halted } = await human.call("build_control", { build_id: buildId, action: "halt", reason: "pause for review" });
    assertFields(halted, { status: "halted", halt_reason: "pause for review", status_before_halt: "awaiting_plan_approval" });
    await cd.fails("send", status("orchestrator", "x"), "halted");
    await o.fails("ledger_update", { build_id: buildId, task_id: "T1", note: "x" }, "halted");
    assert.equal(entryFor(await o.call("inbox", {}), buildId).status, "halted");
    await human.call("send", status("orchestrator", "Paused while I look."));
    await human.fails("build_control", { build_id: buildId, action: "halt" }, "conflict");
    await human.fails("gate_decide", { build_id: buildId, gate_id: gate.id, decision: "approved" }, "conflict");
    assert.equal((await human.call("build_list", {})).builds[0].status, "halted");

    const { build: resumed } = await human.call("build_control", { build_id: buildId, action: "resume" });
    assertFields(resumed, { status: "awaiting_plan_approval", halt_reason: null, status_before_halt: null });
    await human.fails("build_control", { build_id: buildId, action: "resume" }, "conflict");

    const { build: cancelled } = await human.call("build_control", { build_id: buildId, action: "cancel", reason: "scrapped" });
    assert.equal(cancelled.status, "cancelled");
    await cd.fails("send", status("orchestrator", "x"), "conflict");
    await human.fails("send", status("orchestrator", "x"), "conflict");
    await human.fails("build_control", { build_id: buildId, action: "resume" }, "conflict");
    const l = await human.call("ledger_get", { build_id: buildId });
    assertFields(l.gates.find((g) => g.id === gate.id), { status: "cancelled" });
    assertAudit(l.audit, [
      ["human", /halt/, buildId],
      ["human", /resum/, buildId],
      ["human", /cancel/, buildId],
    ]);
    assert.ok(!(await human.call("build_list", {})).builds.some((b) => b.build_id === buildId));
    assertFields((await human.call("build_list", { include_closed: true })).builds.find((b) => b.build_id === buildId), { status: "cancelled" });
    assert.ok(!(await o.call("inbox", {})).builds.some((b) => b.build_id === buildId));
  });

  test("races: concurrent build_create, parallel sends at the cap, parallel bursts", async () => {
    const creates = await Promise.all(ROLES.concat(ROLES).map((_, i) => relay.call("human", "build_create", { title: `Race ${i}`, brief: BRIEF })));
    assert.deepEqual(creates.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409], "MAX_ACTIVE_BUILDS=1 holds under concurrency");
    const raceId = creates.find((r) => r.ok).result.build_id;
    await o.call("ledger_update", { build_id: raceId, title: "T", assignee: "developer" });
    await human.call("build_control", { build_id: raceId, action: "set_caps", caps: { max_messages: 3 } });
    const senders = ["orchestrator", "creative-director", "developer", "orchestrator", "creative-director", "developer"];
    const sends = await Promise.all(senders.map((role, i) => relay.call(role, "send", { build_id: raceId, to_role: "human", type: "status", body: `race ${i}` })));
    const codes = sends.map((r) => (r.ok ? "ok" : r.error.code)).sort();
    assert.deepEqual(codes, ["cap_reached", "halted", "halted", "ok", "ok", "ok"]);
    const l = await human.call("ledger_get", { build_id: raceId });
    assertFields(l.build, { status: "halted", message_count: 3 });
    assert.equal(l.messages.filter((m) => m.from === "relay" && m.to === "human").length, 1, "the human is told once");

    await human.call("build_control", { build_id: raceId, action: "cancel" });
    const burstId = (await human.call("build_create", { title: "Burst race", brief: BRIEF })).build_id;
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => relay.call("developer", "send", { build_id: burstId, to_role: "orchestrator", type: "status", body: `b${i}` })));
    assert.deepEqual(burst.filter((r) => r.ok).length, 4, "exactly BURST_PER_MINUTE accepted");
    assert.ok(burst.filter((r) => !r.ok).every((r) => r.status === 429 && r.error.code === "rate_limited"));
    await human.call("build_control", { build_id: burstId, action: "cancel" });
  });
});

// =====================================================================================
describe("6. security", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;

  before(async () => {
    relay = await startRelay();
    team = await connectTeam(relay, { pathRoles: ["developer", "human"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
    buildId = await startBuild(team);
    await drain([o, cd, dev, human], buildId);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  test("impersonation: fields naming another sender never change who the relay stamps", async () => {
    const base = { build_id: buildId, to_role: "orchestrator", type: "status", body: "spoof attempt" };
    const attempts = [
      ["from", "creative-director"],
      ["from", "relay"],
      ["sender", "human"],
      ["from_role", "orchestrator"],
      ["on_behalf_of", "orchestrator"],
      ["as_role", "human"],
      ["actor", "creative-director"],
      ["role", "human"],
    ];
    for (const [field, value] of attempts) {
      const res = await dev.tryCall("send", { ...base, body: `spoof ${field}=${value}`, [field]: value });
      if (res.ok) {
        assertFields(res.result.message, { from: "developer", on_behalf_of: null }, `${field}=${value}`);
      } else {
        assert.ok(["forbidden", "invalid_input"].includes(res.code), `${field}=${value}: ${res.text}`);
      }
    }
    // The same over the JSON API.
    const api = await relay.call("developer", "send", { ...base, body: "spoof via API", from: "human" });
    if (api.ok) assert.equal(api.result.message.from, "developer");
    else assert.ok([403, 400].includes(api.status));

    // A spoofed verdict does not move the task.
    await dev.tryCall("send", { build_id: buildId, to_role: "creative-director", type: "verdict", task_id: "T1", verdict: "approved", body: "x", from: "creative-director" });
    await dev.tryCall("ledger_update", { build_id: buildId, task_id: "T1", status: "done", actor: "orchestrator" });
    const l = await human.call("ledger_get", { build_id: buildId });
    assert.deepEqual(l.verdicts, []);
    assert.notEqual(taskIn(l, "T1").status, "done");
    for (const m of l.messages.filter((x) => x.body.startsWith("spoof"))) {
      assert.equal(m.from, "developer", `${m.id} is stamped with the token's role`);
      assert.equal(m.on_behalf_of, null);
    }
    assert.ok(!l.messages.some((m) => m.from === "relay" && m.body.startsWith("spoof")));
  });

  test("addressing: relay, self and unknown roles are refused; aliases resolve", async () => {
    const send = (agent, to_role) => agent.tryCall("send", { build_id: buildId, to_role, type: "status", body: `to ${to_role}` });
    for (const to of ["relay", "Relay", " relay "]) assert.equal((await send(dev, to)).code, "invalid_input", `to ${to}`);
    for (const to of ["developer", "dev", "full-stack-developer", "Full-Stack Developer"]) assert.equal((await send(dev, to)).code, "invalid_input", `self ${to}`);
    assert.equal((await send(human, "james")).code, "invalid_input", "human to james (self)");
    assert.equal((await send(dev, "qa")).code, "invalid_input");
    const viaApi = await relay.call("developer", "send", { build_id: buildId, to_role: "relay", type: "status", body: "x" });
    assert.deepEqual([viaApi.status, viaApi.error.code], [400, "invalid_input"]);
    for (const [to, canonical] of [["orch", "orchestrator"], ["cd", "creative-director"], ["Creative Director", "creative-director"], ["James", "human"]]) {
      const res = await send(dev, to);
      assert.ok(res.ok, `${to}: ${res.text}`);
      assert.equal(res.result.message.to, canonical);
    }
    const reply = await send(o, "dev");
    assert.equal(reply.result.message.to, "developer");
    await dev.fails("send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x", reply_to: "M999" }, "not_found");
    await dev.fails("send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x", links: [{ url: "javascript:alert(1)" }] }, "invalid_input");
    await dev.fails("send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x", links: [{ url: "ftp://example.com/a" }] }, "invalid_input");
    await dev.fails("send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "" }, "invalid_input");
  });

  test("input limits (DESIGN §6): body, links and changes", async () => {
    const base = { build_id: buildId, to_role: "orchestrator", type: "status" };
    await human.call("send", { ...base, body: "x".repeat(20_000) });
    await human.fails("send", { ...base, body: "x".repeat(20_001) }, "invalid_input");
    const link = (i) => ({ url: `https://example.com/${i}`, label: "l" });
    await human.call("send", { ...base, body: "20 links", links: Array.from({ length: 20 }, (_, i) => link(i)) });
    await human.fails("send", { ...base, body: "21 links", links: Array.from({ length: 21 }, (_, i) => link(i)) }, "invalid_input");
    await human.fails("send", { ...base, body: "long url", links: [{ url: `https://example.com/${"a".repeat(2000)}` }] }, "invalid_input");
    await human.fails("send", { ...base, body: "long label", links: [{ url: "https://example.com/", label: "l".repeat(201) }] }, "invalid_input");
    const verdict = { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "changes_requested", body: "v" };
    await cd.fails("send", { ...verdict, changes: [] }, "invalid_input");
    await cd.fails("send", { ...verdict, changes: Array.from({ length: 51 }, (_, i) => `c${i}`) }, "invalid_input");
    await cd.fails("send", { ...verdict, changes: ["x".repeat(2001)] }, "invalid_input");
    await dev.fails("send", { ...base, body: "verdict field on a status", verdict: "approved" }, "invalid_input");
  });

  test("wrong-role tool calls are forbidden over MCP and the JSON API", async () => {
    const humanOnly = [
      ["gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved" }],
      ["build_control", { build_id: buildId, action: "halt" }],
      ["kill_switch", { on: true, reason: "nope" }],
    ];
    for (const agent of [o, cd, dev]) {
      for (const [tool, input] of humanOnly) {
        await agent.fails(tool, input, "forbidden");
        const api = await relay.call(agent.role, tool, input);
        assert.deepEqual([api.status, api.error.code], [403, "forbidden"], `${agent.role} ${tool} via API`);
      }
    }
    for (const agent of [cd, dev]) {
      await agent.fails("build_create", { title: "x", brief: "x" }, "forbidden");
      await agent.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "forbidden");
    }
    assert.equal((await human.call("whoami")).halted.global, false, "the refused kill switch call changed nothing");
    // Ledger permissions (DESIGN §10).
    await dev.fails("send", { build_id: buildId, to_role: "creative-director", type: "task", task_id: "T1", body: "you do it" }, "forbidden");
    await o.fails("send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "approved", body: "x" }, "forbidden");
    await cd.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" }, "forbidden");
    await dev.fails("ledger_update", { build_id: buildId, task_id: "T1", reviewer: null }, "forbidden");
    await o.fails("ledger_update", { build_id: buildId, task_id: "T1", status: "in_review" }, "forbidden");
    const done = await o.tryCall("ledger_update", { build_id: buildId, task_id: "T1", status: "done" });
    assert.ok(!done.ok && ["conflict", "forbidden"].includes(done.code), `orchestrator cannot mark a reviewed task done without an approved verdict: ${done.text}`);
  });

  test("secret scanner: keys in body, changes, links, notes, summaries and briefs are refused, never echoed", async () => {
    const SECRETS = {
      anthropic: `sk-ant-api03-${"Ab3".repeat(10)}`,
      openai: `sk-${"a1B2c3D4".repeat(5)}`,
      github: `ghp_${"Z9y8X7w6".repeat(5)}`,
      github_pat: `github_pat_${"11ABCDEFG0".repeat(3)}`,
      aws: "AKIAIOSFODNN7EXAMPLE",
      slack: "xoxb-1234567890-abcdefghijkl",
      google: `AIza${"Sy0-_b".repeat(6)}abcde`.slice(0, 39),
      stripe: `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
      pem: "-----BEGIN RSA PRIVATE KEY-----",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      role_token: relay.tokens.orchestrator,
      connector_url: `https://relay.example.workers.dev/mcp/${relay.tokens.developer}`,
    };
    const expectSecret = async (agent, tool, input, secret, label) => {
      const res = await agent.fails(tool, input, "secret_detected");
      assert.ok(!res.text.includes(secret), `${label}: the error never echoes the value`);
    };
    for (const [kind, secret] of Object.entries(SECRETS)) {
      await expectSecret(dev, "send", { build_id: buildId, to_role: "orchestrator", type: "status", body: `deploy with ${secret} please` }, secret, `body ${kind}`);
    }
    // links, label, changes (with the task really in review), notes, titles, summaries, decisions, briefs, session_ref.
    await expectSecret(dev, "send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "r1", links: [{ url: `https://preview.example.com/?token=${SECRETS.github}` }] }, SECRETS.github, "link url");
    await expectSecret(dev, "send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "r1", links: [{ url: "https://preview.example.com/", label: SECRETS.aws }] }, SECRETS.aws, "link label");
    await dev.call("send", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: "T1", body: "r1", links: [PREVIEW_1] });
    await expectSecret(cd, "send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: "T1", verdict: "changes_requested", body: "fix", changes: ["ok item", `use ${SECRETS.stripe}`] }, SECRETS.stripe, "changes");
    await expectSecret(cd, "ledger_update", { build_id: buildId, task_id: "T1", note: `key ${SECRETS.anthropic}` }, SECRETS.anthropic, "note");
    await expectSecret(o, "ledger_update", { build_id: buildId, title: `Rotate ${SECRETS.slack}`, assignee: "developer" }, SECRETS.slack, "title");
    await expectSecret(o, "ledger_update", { build_id: buildId, title: "Task", description: SECRETS.pem, assignee: "developer" }, SECRETS.pem, "description");
    await expectSecret(o, "gate_request", { build_id: buildId, kind: "final_signoff", summary: `Shipped; JWT ${SECRETS.jwt}` }, SECRETS.jwt, "summary");
    await expectSecret(human, "gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved", note: SECRETS.openai }, SECRETS.openai, "decision note");
    await expectSecret(human, "build_create", { title: "x", brief: `use ${SECRETS.google}` }, SECRETS.google, "brief");
    await expectSecret(dev, "inbox", { build_id: buildId, session_ref: SECRETS.role_token }, SECRETS.role_token, "session_ref");
    const api = await relay.call("developer", "send", { build_id: buildId, to_role: "orchestrator", type: "status", body: SECRETS.aws });
    assert.deepEqual([api.status, api.error.code], [400, "secret_detected"]);
    assert.ok(!api.error.message.includes(SECRETS.aws));

    // A 1Password reference is how secrets are named, and it is allowed.
    const ref = await dev.call("send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "Stripe key: op://Agent Relay/Stripe/secret-key" });
    assert.equal(ref.message.body, "Stripe key: op://Agent Relay/Stripe/secret-key");

    const l = await human.call("ledger_get", { build_id: buildId });
    const stored = JSON.stringify(l);
    for (const [kind, secret] of Object.entries(SECRETS)) assert.ok(!stored.includes(secret), `${kind} never reached the ledger`);
    assertFields(taskIn(l, "T1"), { status: "in_review" });
    assert.deepEqual(l.verdicts, []);
  });

  test("unknown or missing tokens get 401 from MCP and the JSON API", async () => {
    const bogus = `e2e-bogus-${randomBytes(24).toString("base64url")}`;
    for (const pathToken of [false, true]) {
      await assert.rejects(connect(relay, "developer", { pathToken, token: bogus }), (err) => {
        assert.equal(err.code, 401, `${pathToken ? "path" : "header"}: ${err.message}`);
        return true;
      });
    }
    const raw = await http(relay, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal(raw.status, 401);
    assert.ok(raw.body.error, "a JSON-RPC error body");
    const wrongPath = await http(relay, `/mcp/${bogus}`, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(wrongPath.status, 401);

    for (const [path, method] of [["/api/me", "GET"], ["/api/builds", "GET"], [`/api/builds/${buildId}`, "GET"], ["/api/inbox?peek=1", "GET"], ["/api/call/whoami", "POST"]]) {
      for (const token of [undefined, bogus, ""]) {
        const res = await http(relay, path, { method, token, ...(method === "POST" ? { body: {} } : {}) });
        assert.equal(res.status, 401, `${method} ${path} token=${token === undefined ? "none" : token ? "bogus" : "empty"}`);
        assert.deepEqual([res.body.ok, res.body.error.code], [false, "unauthorized"]);
      }
    }
    // The path form is for MCP only.
    assert.equal((await http(relay, `/api/me/${relay.tokens.human}`)).status, 401);
    // DESIGN §2: the Authorization header is the first token source, the path form the second.
    const both = await http(relay, `/mcp/${relay.tokens.human}`, {
      method: "POST",
      token: relay.tokens.developer,
      headers: { accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } },
    });
    assert.equal(both.body.result.structuredContent.role, "developer");
  });

  test("a role whose token is shorter than 32 characters is disabled", async () => {
    const short = "d".repeat(31);
    const exact = "c".repeat(32);
    const other = await startRelay({ tokens: { developer: short, "creative-director": exact } });
    try {
      for (const pathToken of [false, true]) {
        await assert.rejects(connect(other, "developer", { pathToken }), (err) => err.code === 401);
      }
      const api = await other.call("developer", "whoami", {});
      assert.deepEqual([api.status, api.error.code], [401, "unauthorized"]);
      const cdAgent = await connect(other, "creative-director", { pathToken: true });
      try {
        assert.equal((await cdAgent.call("whoami")).role, "creative-director", "a 32-character token is enough");
      } finally {
        await cdAgent.close();
      }
      const me = await other.call("human", "whoami", {});
      assert.deepEqual(
        me.result.roles.map((r) => [r.id, r.enabled]),
        [
          ["orchestrator", true],
          ["creative-director", true],
          ["developer", false],
          ["human", true],
        ],
      );
    } finally {
      await other.stop();
    }
  });
});

// =====================================================================================
describe("7. gate configuration", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;

  before(async () => {
    relay = await startRelay();
    team = await connectTeam(relay, { pathRoles: ["orchestrator", "creative-director"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  test("gates off: plan approval and final sign-off are approved automatically, without asking the human", async () => {
    const build = await human.call("build_create", { title: "No gates", brief: BRIEF, gates: { plan_approval: false, final_signoff: false } });
    const buildId = build.build_id;
    assert.deepEqual(build.gates, { plan_approval: false, final_signoff: false });
    await o.call("ledger_update", { build_id: buildId, title: "Script", assignee: "developer" });
    const plan = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan: T1." });
    assertFields(plan.gate, { kind: "plan_approval", status: "approved", auto: true, decided_by: "relay", decided_at: ISO });
    assert.equal(plan.build.status, "in_progress");

    const open = await o.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "Done?" }, "conflict");
    assert.match(open.message, /T1/);
    await o.call("send", { build_id: buildId, to_role: "developer", type: "task", task_id: "T1", body: "Go" });
    const { task } = await dev.call("ledger_update", { build_id: buildId, task_id: "T1", status: "done" });
    assertFields(task, { status: "done", owner: null });

    const final = await o.call("gate_request", { build_id: buildId, kind: "final_signoff", summary: "Shipped.", links: [PRODUCTION] });
    assertFields(final.gate, { kind: "final_signoff", status: "approved", auto: true, decided_by: "relay" });
    assert.equal(final.build.status, "shipped");
    await assertNoUnread([human], buildId);
    const l = await human.call("ledger_get", { build_id: buildId });
    assert.deepEqual(l.gates.map((g) => [g.kind, g.status, g.auto]), [
      ["plan_approval", "approved", true],
      ["final_signoff", "approved", true],
    ]);
    assertAudit(l.audit, [
      ["relay", /gate/, plan.gate.id],
      ["relay", /gate/, final.gate.id],
    ]);
  });

  test("gates on: final sign-off is refused while tasks are open; a rejection sends the build back to in_progress", async () => {
    const build = await human.call("build_create", { title: "Gated", brief: BRIEF });
    const buildId = build.build_id;
    await o.call("ledger_update", { build_id: buildId, title: "Screen", assignee: "developer", reviewer: "creative-director" });
    await o.call("ledger_update", { build_id: buildId, title: "Docs", assignee: "developer" });
    await o.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "conflict");
    const plan = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan" });
    await human.call("gate_decide", { build_id: buildId, gate_id: plan.gate.id, decision: "approved" });

    const both = await o.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "conflict");
    assert.match(both.message, /T1/);
    assert.match(both.message, /T2/);
    await o.call("send", { build_id: buildId, to_role: "developer", type: "task", task_id: "T2", body: "Docs" });
    await dev.call("ledger_update", { build_id: buildId, task_id: "T2", status: "done" });
    const one = await o.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "conflict");
    assert.match(one.message, /T1/);
    assert.doesNotMatch(one.message, /T2/);
    await o.call("ledger_update", { build_id: buildId, task_id: "T1", status: "cancelled", note: "Out of scope" });

    const final = await o.call("gate_request", { build_id: buildId, kind: "final_signoff", summary: "Docs shipped." });
    assertFields(final.gate, { status: "pending", auto: false });
    assert.equal(final.build.status, "awaiting_signoff");
    await o.fails("gate_request", { build_id: buildId, kind: "final_signoff", summary: "again" }, "conflict");
    await drain([o, human], buildId);
    const rejected = await human.call("gate_decide", { build_id: buildId, gate_id: final.gate.id, decision: "rejected", note: "Add a README" });
    assert.equal(rejected.build.status, "in_progress");
    const told = await deliver(o, buildId, [{ from: "human", body: /Add a README/ }]);
    assert.ok(told.messages[0].body.includes(final.gate.id));

    const again = await o.call("gate_request", { build_id: buildId, kind: "final_signoff", summary: "README added." });
    const shipped = await human.call("gate_decide", { build_id: buildId, gate_id: again.gate.id, decision: "approved" });
    assert.equal(shipped.build.status, "shipped");
  });

  test("plan rejected: back to planning with the note; the orchestrator revises and asks again", async () => {
    const buildId = (await human.call("build_create", { title: "Replan", brief: BRIEF })).build_id;
    await o.call("ledger_update", { build_id: buildId, title: "Screen", assignee: "creative-director", reviewer: "creative-director" });
    await o.fails("gate_request", { build_id: buildId, kind: "plan_approval", summary: "" }, "invalid_input");
    const first = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "One screen." });
    // question and status are fine while awaiting approval; work messages are not.
    await cd.call("send", { build_id: buildId, to_role: "orchestrator", type: "question", body: "Dark mode too?" });
    await o.fails("send", { build_id: buildId, to_role: "creative-director", type: "task", task_id: "T1", body: "Start" }, "conflict");
    await drain([o, human], buildId);
    const rejected = await human.call("gate_decide", { build_id: buildId, gate_id: first.gate.id, decision: "rejected", note: "Add a settings screen" });
    assertFields(rejected.gate, { status: "rejected", note: "Add a settings screen" });
    assert.equal(rejected.build.status, "planning");
    await deliver(o, buildId, [{ from: "human", body: /Add a settings screen/ }]);
    await o.call("ledger_update", { build_id: buildId, title: "Settings screen", assignee: "creative-director", reviewer: "creative-director" });
    const second = await o.call("gate_request", { build_id: buildId, kind: "plan_approval", summary: "Two screens." });
    assertFields(second.gate, { id: "G2", status: "pending" });
    await deliver(human, buildId, [{ from: "relay", type: "question", body: /G2/ }]);
    const approved = await human.call("gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" });
    assert.equal(approved.build.status, "in_progress");
    await human.call("build_control", { build_id: buildId, action: "cancel" });
  });
});

// =====================================================================================
describe("8. JSON API parity, error envelope and CORS", { concurrency: 1 }, () => {
  let relay;
  let team;
  let o, cd, dev, human;
  let buildId;

  before(async () => {
    relay = await startRelay();
    team = await connectTeam(relay, { pathRoles: ["human"] });
    ({ orchestrator: o, "creative-director": cd, developer: dev, human } = team);
    buildId = (await human.call("build_create", { title: "Parity", brief: BRIEF })).build_id;
    await o.call("ledger_update", { build_id: buildId, title: "Screen", assignee: "creative-director", reviewer: "creative-director" });
    await o.call("send", { build_id: buildId, to_role: "developer", type: "question", body: "Which stack?" });
  });
  after(async () => {
    await closeTeam(team);
    await relay?.stop();
  });

  const api = async (role, path) => {
    const res = await http(relay, path, { role });
    assert.equal(res.status, 200, `GET ${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    return res.body.result;
  };
  const apiCall = async (role, tool, input) => {
    const res = await relay.call(role, tool, input);
    assert.equal(res.status, 200, `${tool}: ${JSON.stringify(res)}`);
    assert.equal(res.ok, true);
    return res.result;
  };

  test("read tools give identical results over MCP, GET routes and POST /api/call", async () => {
    for (const agent of [o, cd, dev, human]) {
      const mcp = await agent.call("whoami");
      assert.deepEqual(await api(agent.role, "/api/me"), mcp, `${agent.role} /api/me`);
      assert.deepEqual(await apiCall(agent.role, "whoami", {}), mcp);
    }
    const list = await dev.call("build_list", {});
    assert.deepEqual(await api("developer", "/api/builds"), list);
    assert.deepEqual(await apiCall("developer", "build_list", {}), list);
    assert.deepEqual(await api("developer", "/api/builds?include_closed=1"), await dev.call("build_list", { include_closed: true }));

    const ledger = await cd.call("ledger_get", { build_id: buildId });
    assert.deepEqual(await api("creative-director", `/api/builds/${buildId}`), ledger);
    assert.deepEqual(await apiCall("creative-director", "ledger_get", { build_id: buildId }), ledger);

    const peek = await dev.call("inbox", { build_id: buildId, peek: true });
    assert.equal(entryFor(peek, buildId).messages.length, 1);
    assert.deepEqual(await api("developer", `/api/inbox?build_id=${buildId}&peek=1`), peek);
    assert.deepEqual(await apiCall("developer", "inbox", { build_id: buildId, peek: true }), peek);
    assert.deepEqual(await api("developer", `/api/inbox?build_id=${buildId}&since=0&peek=1&limit=5`), await dev.call("inbox", { build_id: buildId, since: 0, peek: true, limit: 5 }));
    assert.deepEqual(await api("developer", "/api/inbox?peek=1"), await dev.call("inbox", { peek: true }));
  });

  test("write tools behave the same over MCP and POST /api/call", async () => {
    const input = { build_id: buildId, title: "Same task", description: "Twice", assignee: "developer", reviewer: "creative-director" };
    const viaMcp = await o.call("ledger_update", input);
    const viaApi = await apiCall("orchestrator", "ledger_update", input);
    assert.notEqual(viaMcp.task.id, viaApi.task.id);
    assert.deepEqual(normalize(viaApi), normalize(viaMcp));

    const msg = { build_id: buildId, to_role: "developer", type: "status", body: "Same message", task_id: viaMcp.task.id, links: [SPEC] };
    const sentMcp = await o.call("send", msg);
    const sentApi = await apiCall("orchestrator", "send", msg);
    assert.deepEqual(normalize(sentApi), normalize(sentMcp));
    assert.equal(sentApi.message.seq, sentMcp.message.seq + 1);
  });

  test("error envelope and HTTP status per DESIGN §12, with the same code and message over MCP", async () => {
    const cases = [
      ["forbidden", 403, dev, "gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved" }],
      ["forbidden", 403, dev, "ledger_update", { build_id: buildId, task_id: "T1", status: "in_progress" }],
      ["not_found", 404, dev, "ledger_get", { build_id: "b-aaaaaaaaaa" }],
      ["not_found", 404, dev, "send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x", task_id: "T99" }],
      ["invalid_input", 400, dev, "send", { build_id: buildId, to_role: "relay", type: "status", body: "x" }],
      ["invalid_input", 400, dev, "send", { build_id: "not-a-build", to_role: "orchestrator", type: "status", body: "x" }],
      ["invalid_input", 400, dev, "inbox", { limit: 0 }],
      ["conflict", 409, human, "build_create", { title: "Second", brief: "Only one build at a time" }],
      ["conflict", 409, o, "send", { build_id: buildId, to_role: "creative-director", type: "task", task_id: "T1", body: "planning" }],
      ["secret_detected", 400, dev, "send", { build_id: buildId, to_role: "orchestrator", type: "status", body: "AKIAIOSFODNN7EXAMPLE" }],
    ];
    for (const [code, status, agent, tool, input] of cases) {
      const viaApi = await relay.call(agent.role, tool, input);
      assert.equal(viaApi.status, status, `${agent.role} ${tool} -> ${code}`);
      assert.equal(viaApi.ok, false);
      assert.equal(viaApi.error.code, code);
      assert.equal(typeof viaApi.error.message, "string");
      assert.ok(viaApi.error.message.length > 0);
      const viaMcp = await agent.fails(tool, input, code);
      assert.equal(viaMcp.text, `${code}: ${viaApi.error.message}`, `${tool}: MCP text is "<code>: <message>" of the same error`);
    }
    const unauthorized = await http(relay, "/api/me", { token: "nope" });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(Object.keys(unauthorized.body).sort(), ["error", "ok"]);
    assert.deepEqual(Object.keys(unauthorized.body.error).sort(), ["code", "message"]);
  });

  test("unknown tools and routes, wrong methods, malformed bodies", async () => {
    const unknown = await relay.call("human", "nope", {});
    assert.deepEqual([unknown.status, unknown.error.code], [404, "not_found"]);
    await assert.rejects(human.client.callTool({ name: "nope", arguments: {} }), (err) => err.code === -32602);
    assert.equal((await http(relay, "/api/call/whoami", { role: "human" })).status, 405);
    const route = await http(relay, "/api/nope", { role: "human" });
    assert.deepEqual([route.status, route.body.error.code], [404, "not_found"]);
    const badJson = await http(relay, "/api/call/send", { method: "POST", role: "human", headers: { "content-type": "application/json" }, rawBody: "{oops" });
    assert.deepEqual([badJson.status, badJson.body.error.code], [400, "invalid_input"]);
    const badLimit = await http(relay, "/api/inbox?limit=0", { role: "human" });
    assert.deepEqual([badLimit.status, badLimit.body.error.code], [400, "invalid_input"]);
    const badSince = await http(relay, `/api/inbox?build_id=${buildId}&since=abc`, { role: "human" });
    assert.deepEqual([badSince.status, badSince.body.error.code], [400, "invalid_input"]);
  });

  test("inbox semantics: unread vs since vs peek vs limit, and presence", async () => {
    await drain([dev], buildId);
    const sent = [];
    for (const n of [1, 2, 3]) sent.push((await o.call("send", { build_id: buildId, to_role: "developer", type: "status", body: `note ${n}` })).message);
    const first = entryFor(await dev.call("inbox", { build_id: buildId, limit: 2 }), buildId);
    assert.deepEqual(first.messages.map((m) => m.id), [sent[0].id, sent[1].id]);
    assert.equal(first.unread_remaining, 1);
    assert.equal(first.cursor, sent[1].seq);
    const rest = entryFor(await dev.call("inbox", { build_id: buildId }), buildId);
    assert.deepEqual(rest.messages.map((m) => m.id), [sent[2].id]);
    assert.equal(rest.unread_remaining, 0);
    const since = entryFor(await dev.call("inbox", { build_id: buildId, since: sent[0].seq, peek: true }), buildId);
    assert.deepEqual(since.messages.map((m) => m.id).slice(-2), [sent[1].id, sent[2].id]);
    assert.ok(!since.messages.some((m) => m.seq <= sent[0].seq), "since excludes seq <= since");

    // A peek returns unread messages without marking them; since + peek shows read and unread alike.
    const fresh = (await o.call("send", { build_id: buildId, to_role: "developer", type: "status", body: "note 4" })).message;
    const peekSince = entryFor(await dev.call("inbox", { build_id: buildId, since: sent[2].seq, peek: true }), buildId);
    assertFields(peekSince.messages[0], { id: fresh.id, read_at: null });
    assert.equal(peekSince.unread_remaining, 0);
    const peekUnread = entryFor(await dev.call("inbox", { build_id: buildId, peek: true }), buildId);
    assert.equal(peekUnread.unread_remaining, 0);
    assert.deepEqual(peekUnread.messages.map((m) => m.id), [fresh.id]);
    // since without build_id is ignored: unread only, then marked read.
    const across = entryFor(await dev.call("inbox", { since: 0 }), buildId);
    assert.deepEqual(across.messages.map((m) => m.id), [fresh.id]);
    assert.deepEqual(entryFor(await dev.call("inbox", { build_id: buildId, peek: true }), buildId).messages, []);

    // Presence: a bare peek leaves the thread row alone; a read or a named poll records it.
    const polled = async () => (await human.call("ledger_get", { build_id: buildId })).threads.find((t) => t.role === "developer");
    const before = await polled();
    await sleep(20);
    await dev.call("inbox", { build_id: buildId, peek: true });
    assert.deepEqual(await polled(), before, "a bare peek has no side effects");
    await dev.call("inbox", { build_id: buildId, peek: true, session_ref: "dev-mod" });
    const named = await polled();
    assert.equal(named.session_ref, "dev-mod");
    assert.ok(Date.parse(named.last_polled_at) > Date.parse(before.last_polled_at ?? 0));
  });

  test("CORS: preflight is answered and responses allow any origin without credentials", async () => {
    for (const path of ["/api/call/send", "/api/inbox", "/mcp"]) {
      const res = await fetch(`${relay.url}${path}`, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      assert.ok(res.status === 204 || res.status === 200, `OPTIONS ${path}: ${res.status}`);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
      const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      assert.ok(allowed.includes("authorization") && allowed.includes("content-type"), allowed);
      assert.equal(res.headers.get("access-control-allow-credentials"), null);
    }
    const okRes = await http(relay, "/api/me", { role: "developer", headers: { origin: "https://claude.ai" } });
    assert.equal(okRes.headers.get("access-control-allow-origin"), "*");
    const errRes = await http(relay, "/api/me", { headers: { origin: "https://claude.ai" } });
    assert.equal(errRes.headers.get("access-control-allow-origin"), "*");
    const mcpRes = await rpc(relay, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(mcpRes.headers.get("access-control-allow-origin"), "*");
  });

  test("ledger_get keeps the last 50 messages and audit rows, oldest first", async () => {
    for (let i = 0; i < 55; i += 1) await human.call("send", { build_id: buildId, to_role: "developer", type: "status", body: `tail ${i}` });
    const l = await human.call("ledger_get", { build_id: buildId });
    assert.equal(l.messages.length, 50);
    assert.equal(l.messages.at(-1).body, "tail 54");
    assert.ok(l.messages.every((m, i) => i === 0 || m.seq > l.messages[i - 1].seq));
    assert.equal(l.audit.length, 50);
    assert.ok(l.audit.every((row, i) => i === 0 || row.seq > l.audit[i - 1].seq));
    assertFields(l.audit.at(-1), { actor: "human", target: l.messages.at(-1).id });
    const inbox = entryFor(await dev.call("inbox", { build_id: buildId, peek: true, limit: 100 }), buildId);
    assert.ok(inbox.messages.length >= 55);
    await assert.rejects(dev.call("inbox", { build_id: buildId, limit: 101 }), /invalid_input/);
  });

  test("spike endpoints: any role posts events, only the human reads them and creates wakes", async () => {
    const posted = await http(relay, "/spike/events", { method: "POST", role: "developer", body: { event: "SessionStart", session_id: "s-1", surface: "cli", detail: { a: 1 } } });
    assert.equal(posted.status, 200);
    assertFields(posted.body.result.event, { role: "developer", event: "SessionStart", session_id: "s-1", detail: { a: 1 } });
    const big = await http(relay, "/spike/events", { method: "POST", role: "developer", body: { event: "x", detail: { blob: "x".repeat(5000) } } });
    assert.deepEqual([big.status, big.body.error.code], [400, "invalid_input"]);
    const secret = await http(relay, "/spike/events", { method: "POST", role: "developer", body: { event: "x", detail: { key: "AKIAIOSFODNN7EXAMPLE" } } });
    assert.deepEqual([secret.status, secret.body.error.code], [400, "secret_detected"]);
    assert.equal((await http(relay, "/spike/events", { role: "developer" })).status, 403);
    const events = await http(relay, "/spike/events", { role: "human" });
    assert.deepEqual(events.body.result.events.map((e) => e.event), ["SessionStart"]);
    assert.equal((await http(relay, "/spike/events", { method: "POST", body: { event: "x" } })).status, 401);

    assert.equal((await http(relay, "/spike/wake", { method: "POST", role: "developer", body: { text: "wake" } })).status, 403);
    const targeted = await http(relay, "/spike/wake", { method: "POST", role: "human", body: { session_id: "s-1", text: "check inbox" } });
    assert.equal(targeted.status, 200);
    await http(relay, "/spike/wake", { method: "POST", role: "human", body: { text: "anyone" } });
    const other = await http(relay, "/spike/wake?session_id=s-2", { role: "creative-director" });
    assert.deepEqual(other.body.result.wakes.map((w) => w.text), ["anyone"], "untargeted wakes go to the first poller");
    const mine = await http(relay, "/spike/wake?session_id=s-1", { role: "developer" });
    assert.deepEqual(mine.body.result.wakes.map((w) => w.text), ["check inbox"]);
    const again = await http(relay, "/spike/wake?session_id=s-1", { role: "developer" });
    assert.deepEqual(again.body.result.wakes, [], "wakes are consumed");
  });

  test("health and the ledger page need no auth", async () => {
    const health = await http(relay, "/health");
    assertFields(health.body, { ok: true, name: "agent-relay" });
    assert.match(health.body.version, /\d+\.\d+\.\d+/);
    const page = await fetch(`${relay.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await page.text(), /<html/i);
  });
});
