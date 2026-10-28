import { describe, expect, it } from "vitest";
import {
  call,
  callRaw,
  createBuild,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  useCleanState,
  type Json,
  type Role,
} from "./helpers";

useCleanState();

const AGENTS: Role[] = ["orchestrator", "creative-director", "developer"];

describe("whoami", () => {
  it("describes the caller and the role directory", async () => {
    const me = await call("creative-director", "whoami");
    expect(me).toMatchObject({
      role: "creative-director",
      display_name: "Creative Director",
      halted: { global: false, reason: null, at: null },
      version: "0.1.0",
    });
    expect(me.roles).toEqual([
      { id: "orchestrator", display_name: "Orchestrator", aliases: ["orch"], enabled: true },
      { id: "creative-director", display_name: "Creative Director", aliases: ["cd", "creative"], enabled: true },
      { id: "developer", display_name: "Full-Stack Developer", aliases: ["full-stack-developer", "dev"], enabled: true },
      { id: "human", display_name: "James", aliases: ["james"], enabled: true },
    ]);
  });
});

describe("build_create", () => {
  it("creates a planning build and sends the brief to the orchestrator when James creates it", async () => {
    const build = await createBuild({ caps: { max_messages: 50 } });
    expect(build.build_id).toMatch(/^b-[a-z2-7]{10}$/);
    expect(build).toMatchObject({
      title: "Tip calculator",
      brief: "Build a tip calculator web app.",
      status: "planning",
      gates: { plan_approval: true, final_signoff: true },
      caps: { max_messages: 50, max_review_rounds: 3 },
      message_count: 0,
      created_by: "human",
    });
    const inbox = await call("orchestrator", "inbox", { build_id: build.build_id });
    expect(inbox.builds[0].messages).toEqual([
      expect.objectContaining({
        id: "M1",
        seq: 1,
        from: "human",
        to: "orchestrator",
        type: "task",
        task_id: null,
        body: "Build a tip calculator web app.",
      }),
    ]);
  });

  it("sends no kickoff when the orchestrator creates the build", async () => {
    const build = await call("orchestrator", "build_create", { title: "Self-started", brief: "x", gates: { final_signoff: false } });
    expect(build.created_by).toBe("orchestrator");
    expect(build.gates).toEqual({ plan_approval: true, final_signoff: false });
    expect((await ledger(build.build_id)).messages).toEqual([]);
  });

  it("is refused to other roles", async () => {
    for (const role of ["creative-director", "developer"] as const) {
      await expectError(role, "build_create", { title: "x", brief: "y" }, "forbidden");
    }
  });

  it("validates input", async () => {
    await expectError("human", "build_create", { title: "", brief: "y" }, "invalid_input");
    await expectError("human", "build_create", { title: "x" }, "invalid_input");
    await expectError("human", "build_create", { title: "x", brief: "y", caps: { max_messages: 0 } }, "invalid_input");
  });
});

describe("MAX_ACTIVE_BUILDS", () => {
  it("allows one active build; shipping or cancelling frees the slot", async () => {
    const first = await createBuild({ gates: { plan_approval: false, final_signoff: false } });
    const message = await expectError("human", "build_create", { title: "Second", brief: "x" }, "conflict");
    expect(message).toContain(first.build_id);

    // A halted build is still active.
    await call("human", "build_control", { build_id: first.build_id, action: "halt" });
    await expectError("orchestrator", "build_create", { title: "Second", brief: "x" }, "conflict");
    await call("human", "build_control", { build_id: first.build_id, action: "cancel" });
    const second = await createBuild({ title: "Second", gates: { plan_approval: false, final_signoff: false } });

    // Shipping also frees the slot.
    const taskId = await createTask(second.build_id, { reviewer: null });
    await call("orchestrator", "gate_request", { build_id: second.build_id, kind: "plan_approval", summary: "Plan" });
    await call("developer", "ledger_update", { build_id: second.build_id, task_id: taskId, status: "done" });
    const shipped = await call("orchestrator", "gate_request", { build_id: second.build_id, kind: "final_signoff", summary: "Done" });
    expect(shipped.build.status).toBe("shipped");
    await createBuild({ title: "Third" });
  });
});

describe("concurrent build_create", () => {
  it("admits exactly one build when MAX_ACTIVE_BUILDS is 1", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((i) => callRaw("human", "build_create", { title: `Race ${i}`, brief: "x" })),
    );
    expect(results.filter((result) => result.body.ok)).toHaveLength(1);
    expect(results.filter((result) => result.body.error?.code === "conflict")).toHaveLength(2);
    expect((await call("human", "build_list", { include_closed: true })).builds).toHaveLength(1);
  });
});

describe("build_list", () => {
  it("lists summaries for every role and hides closed builds by default", async () => {
    const { buildId, taskId } = await inProgressBuild();
    for (const role of [...AGENTS, "human"] as Role[]) {
      const { builds } = await call(role, "build_list");
      expect(builds).toHaveLength(1);
      expect(builds[0]).toMatchObject({
        build_id: buildId,
        title: "Tip calculator",
        status: "in_progress",
        halt_reason: null,
        owners: [{ task_id: taskId, title: "Main screen", owner: "developer", status: "todo" }],
        pending_gates: [],
      });
      expect(builds[0].last_message).toMatchObject({ id: "M1", from: "human", to: "orchestrator", type: "task" });
    }
    await call("human", "build_control", { build_id: buildId, action: "cancel" });
    expect((await call("developer", "build_list")).builds).toEqual([]);
    const all = await call("developer", "build_list", { include_closed: true });
    expect(all.builds[0]).toMatchObject({ status: "cancelled", owners: [] });
  });

  it("shows pending gates and keeps the summary current after each change", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan v1" });
    const { builds } = await call("human", "build_list");
    expect(builds[0].status).toBe("awaiting_plan_approval");
    expect(builds[0].pending_gates).toEqual([expect.objectContaining({ id: "G1", kind: "plan_approval", status: "pending" })]);
    expect(builds[0].last_message).toMatchObject({ from: "relay", to: "human", type: "question" });
    expect(builds[0].last_message.excerpt.length).toBeLessThanOrEqual(140);
  });
});

describe("ledger_get", () => {
  it("returns the whole ledger to every role", async () => {
    const { buildId } = await inProgressBuild();
    for (const role of [...AGENTS, "human"] as Role[]) {
      const snapshot = await call(role, "ledger_get", { build_id: buildId });
      expect(Object.keys(snapshot)).toEqual(["build", "tasks", "gates", "verdicts", "messages", "threads", "audit"]);
      expect(snapshot.build.status).toBe("in_progress");
      expect(snapshot.tasks).toHaveLength(1);
      expect(snapshot.gates[0]).toMatchObject({ kind: "plan_approval", status: "approved", auto: true });
    }
  });

  it("caps messages and audit at the last 50, oldest first", async () => {
    const build = await createBuild();
    for (let i = 0; i < 55; i += 1) {
      await call("human", "send", { build_id: build.build_id, to_role: "orchestrator", type: "status", body: `note ${i}` });
    }
    const snapshot = await ledger(build.build_id);
    expect(snapshot.messages).toHaveLength(50);
    expect(snapshot.messages[0].seq).toBe(7);
    expect(snapshot.messages.at(-1).seq).toBe(56);
    expect(snapshot.audit).toHaveLength(50);
    expect(snapshot.audit[0].seq).toBeLessThan(snapshot.audit.at(-1).seq);
  });

  it("answers not_found for an unknown build and invalid_input for a malformed id", async () => {
    await expectError("developer", "ledger_get", { build_id: "b-zzzzzzzzzz" }, "not_found");
    await expectError("developer", "ledger_get", { build_id: "B-1" }, "invalid_input");
  });
});

describe("human-only tools", () => {
  it("refuse every agent role", async () => {
    const { buildId } = await inProgressBuild();
    for (const role of AGENTS) {
      await expectError(role, "gate_decide", { build_id: buildId, gate_id: "G1", decision: "approved" }, "forbidden");
      await expectError(role, "build_control", { build_id: buildId, action: "halt" }, "forbidden");
      await expectError(role, "kill_switch", { on: true }, "forbidden");
    }
    for (const role of ["creative-director", "developer"] as const) {
      await expectError(role, "gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "forbidden");
    }
  });
});

describe("send", () => {
  it("returns the message (and the task when one is referenced)", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const result = await call("developer", "send", {
      build_id: buildId,
      to_role: "Creative Director",
      type: "question",
      body: "Which palette?",
      task_id: taskId,
      links: [{ url: "https://figma.example.com/file/1" }],
    });
    expect(result.message).toMatchObject({
      id: "M2",
      seq: 2,
      build_id: buildId,
      from: "developer",
      to: "creative-director",
      type: "question",
      task_id: taskId,
      body: "Which palette?",
      links: [{ url: "https://figma.example.com/file/1" }],
      verdict: null,
      changes: null,
      reply_to: null,
      on_behalf_of: null,
      read_at: null,
    });
    expect(result.message.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.task.id).toBe(taskId);

    const reply = await call("creative-director", "send", {
      build_id: buildId,
      to_role: "dev",
      type: "status",
      body: "Use the brand palette.",
      reply_to: result.message.id,
    });
    expect(reply.message.reply_to).toBe("M2");
    expect(reply.task).toBeUndefined();
  });

  it("validates recipients, references and fields", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const base = { build_id: buildId, type: "status", body: "hi" };
    await expectError("developer", "send", { ...base, to_role: "qa" }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "dev" }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "cd", reply_to: "M99" }, "not_found");
    await expectError("developer", "send", { ...base, to_role: "cd", task_id: "T9" }, "not_found");
    await expectError("developer", "send", { ...base, to_role: "cd", verdict: "approved" }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "cd", body: "" }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "cd", body: "x".repeat(20_001) }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "cd", links: [{ url: "ftp://example.com/a" }] }, "invalid_input");
    await expectError("developer", "send", { ...base, to_role: "cd", links: [{ url: "javascript:alert(1)" }] }, "invalid_input");
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${i}` }));
    await expectError("developer", "send", { ...base, to_role: "cd", links: tooMany }, "invalid_input");
    await expectError(
      "creative-director",
      "send",
      { ...base, to_role: "dev", type: "verdict", task_id: taskId, verdict: "changes_requested", changes: [] },
      "invalid_input",
    );
  });

  it("enforces who may send each work type", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const base = { build_id: buildId, body: "x", task_id: taskId };
    const preview = [{ url: "https://preview.example.com" }];
    await expectError("developer", "send", { ...base, to_role: "cd", type: "task" }, "forbidden");
    await expectError("creative-director", "send", { ...base, to_role: "dev", type: "handoff" }, "forbidden");
    await expectError("creative-director", "send", { ...base, to_role: "dev", type: "review_request", links: preview }, "forbidden");
    await expectError(
      "developer",
      "send",
      { ...base, to_role: "cd", type: "verdict", verdict: "approved" },
      "forbidden",
    );
    // The orchestrator may hand off any task; only the human may send a task message without a task_id.
    const handoff = await call("orchestrator", "send", { ...base, to_role: "cd", type: "handoff", links: preview });
    expect(handoff.task).toMatchObject({ assignee: "creative-director", owner: "creative-director", status: "todo", artifacts: preview });
    await expectError("orchestrator", "send", { build_id: buildId, body: "x", to_role: "dev", type: "task" }, "invalid_input");
    const kickoff = await call("human", "send", { build_id: buildId, body: "x", to_role: "orchestrator", type: "task" });
    expect(kickoff.message.task_id).toBeNull();
  });

  it("assigns a task with a task message", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { task } = await call("orchestrator", "send", {
      build_id: buildId,
      to_role: "creative-director",
      type: "task",
      task_id: taskId,
      body: "Design the main screen first.",
    });
    expect(task).toMatchObject({ assignee: "creative-director", owner: "creative-director", status: "todo" });
  });

  it("refuses work on closed tasks", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "dev", type: "task", task_id: taskId, body: "x" }, "conflict");
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "dev", type: "handoff", task_id: taskId, body: "x" }, "conflict");
  });

  it("creates the recipient's thread on the first message", async () => {
    const { buildId } = await inProgressBuild();
    await call("developer", "send", { build_id: buildId, to_role: "cd", type: "status", body: "hello" });
    const { threads } = await ledger(buildId);
    expect(threads.map((thread: Json) => thread.thread_key)).toEqual([`${buildId}/orchestrator`, `${buildId}/creative-director`]);
    expect(threads[1]).toMatchObject({ role: "creative-director", session_ref: null, last_polled_at: null });
  });

  it("is refused on unknown builds", async () => {
    await expectError("developer", "send", { build_id: "b-aaaaaaaaaa", to_role: "cd", type: "status", body: "x" }, "not_found");
    const { body } = await callRaw("developer", "send", { build_id: "b-aaaaaaaaaa", to_role: "cd", type: "status", body: "x" });
    expect(body.error.message).toContain("build not found");
  });
});
