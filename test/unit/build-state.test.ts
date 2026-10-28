import { describe, expect, it } from "vitest";
import {
  PREVIEW,
  call,
  createBuild,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  readInbox,
  relayTo,
  send,
  task,
  useCleanState,
  type Json,
} from "./helpers";

useCleanState();

async function inboxOf(role: "human" | "orchestrator" | "developer" | "creative-director", buildId: string): Promise<Json[]> {
  const inbox = await call(role, "inbox", { build_id: buildId });
  return inbox.builds[0].messages;
}

describe("plan approval gate", () => {
  it("needs a planning build with at least one task", async () => {
    const build = await createBuild();
    const message = await expectError(
      "orchestrator",
      "gate_request",
      { build_id: build.build_id, kind: "plan_approval", summary: "Plan" },
      "conflict",
    );
    expect(message).toContain("at least one task");
  });

  it("waits for James, then approval moves the build to in_progress", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    const requested = await call("orchestrator", "gate_request", {
      build_id: build.build_id,
      kind: "plan_approval",
      summary: "Two screens, one review round each.",
      links: [{ url: "https://docs.example.com/plan", label: "Plan" }],
    });
    expect(requested.build.status).toBe("awaiting_plan_approval");
    expect(requested.gate).toMatchObject({
      id: "G1",
      kind: "plan_approval",
      status: "pending",
      auto: false,
      requested_by: "orchestrator",
      summary: "Two screens, one review round each.",
      decided_at: null,
    });

    const [question] = await inboxOf("human", build.build_id);
    expect(question).toMatchObject({ from: "relay", to: "human", type: "question", on_behalf_of: "orchestrator" });
    expect(question.body).toContain("G1");
    expect(question.links).toEqual([{ url: "https://docs.example.com/plan", label: "Plan" }]);

    // A second request while one is pending is refused.
    await expectError("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "again" }, "conflict");

    const decided = await call("human", "gate_decide", { build_id: build.build_id, gate_id: "G1", decision: "approved", note: "Ship it" });
    expect(decided.build.status).toBe("in_progress");
    expect(decided.gate).toMatchObject({ status: "approved", decided_by: "human", note: "Ship it" });
    const orchestratorMessages = await inboxOf("orchestrator", build.build_id);
    expect(orchestratorMessages.at(-1)).toMatchObject({ from: "human", type: "status" });
    expect(orchestratorMessages.at(-1).body).toContain("Plan approved");
    expect(orchestratorMessages.at(-1).body).toContain("Ship it");

    await expectError("human", "gate_decide", { build_id: build.build_id, gate_id: "G1", decision: "rejected" }, "conflict");
    await expectError("human", "gate_decide", { build_id: build.build_id, gate_id: "G7", decision: "approved" }, "not_found");
  });

  it("returns the build to planning when rejected", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "v1" });
    const rejected = await call("human", "gate_decide", { build_id: build.build_id, gate_id: "G1", decision: "rejected", note: "Too big" });
    expect(rejected.build.status).toBe("planning");
    expect(rejected.gate.status).toBe("rejected");
    const again = await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "v2" });
    expect(again.gate.id).toBe("G2");
  });

  it("is auto-approved when the gate is disabled, with the decision message the human would send", async () => {
    const build = await createBuild({ gates: { plan_approval: false } });
    await createTask(build.build_id);
    await inboxOf("orchestrator", build.build_id);
    const { gate, build: after } = await call("orchestrator", "gate_request", {
      build_id: build.build_id,
      kind: "plan_approval",
      summary: "Plan",
    });
    expect(after.status).toBe("in_progress");
    expect(gate).toMatchObject({ status: "approved", auto: true, decided_by: "relay" });
    expect(await inboxOf("human", build.build_id)).toEqual([]);
    const [notice] = await inboxOf("orchestrator", build.build_id);
    expect(notice).toMatchObject({ from: "relay", type: "status", task_id: null, on_behalf_of: null });
    expect(notice.body).toBe("Plan auto-approved (plan_approval gate is off). The build is in_progress: assign the first tasks.");
  });
});

describe("final sign-off gate", () => {
  it("needs an in_progress build with every task closed", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    await expectError("orchestrator", "gate_request", { build_id: build.build_id, kind: "final_signoff", summary: "x" }, "conflict");
    await call("human", "build_control", { build_id: build.build_id, action: "cancel" });

    const active = await inProgressBuild();
    const open = await expectError(
      "orchestrator",
      "gate_request",
      { build_id: active.buildId, kind: "final_signoff", summary: "x" },
      "conflict",
    );
    expect(open).toContain(active.taskId);
  });

  it("is refused while an escalation is pending; closing the task by another route cancels that gate", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    const other = await createTask(buildId, { title: "Docs", reviewer: null });
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", {
      build_id: buildId,
      to_role: "dev",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Fix contrast"],
    });
    await call("developer", "ledger_update", { build_id: buildId, task_id: other, status: "done" });
    const message = await expectError("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "conflict");
    expect(message).toContain(taskId); // still open (blocked, escalated)

    // James cancels the task directly: its escalation gate goes with it.
    const { task: cancelled } = await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    expect(cancelled).toMatchObject({ status: "cancelled", owner: null, escalated: false });
    const snapshot = await ledger(buildId);
    expect(snapshot.gates.find((gate: Json) => gate.kind === "escalation")).toMatchObject({ id: "G2", status: "cancelled" });
    expect(snapshot.audit.map((row: Json) => [row.actor, row.action, row.target])).toContainEqual(["human", "gate.cancelled", "G2"]);
    const { build } = await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" });
    expect(build.status).toBe("awaiting_signoff");
  });

  it("ships when approved and reopens when rejected", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });

    const first = await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "All done" });
    expect(first.build.status).toBe("awaiting_signoff");
    const rejected = await call("human", "gate_decide", { build_id: buildId, gate_id: first.gate.id, decision: "rejected" });
    expect(rejected.build.status).toBe("in_progress");

    const second = await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "Now done" });
    const shipped = await call("human", "gate_decide", { build_id: buildId, gate_id: second.gate.id, decision: "approved" });
    expect(shipped.build.status).toBe("shipped");

    // Shipped is terminal.
    await expectError("developer", "send", { build_id: buildId, to_role: "cd", type: "status", body: "x" }, "conflict");
    await expectError("human", "send", { build_id: buildId, to_role: "cd", type: "status", body: "x" }, "conflict");
    await expectError("human", "build_control", { build_id: buildId, action: "halt" }, "conflict");
  });

  it("ships immediately when the gate is disabled, and tells the orchestrator", async () => {
    const { buildId, taskId } = await inProgressBuild({ gates: { plan_approval: false, final_signoff: false } });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    await inboxOf("orchestrator", buildId);
    const { build, gate } = await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" });
    expect(build.status).toBe("shipped");
    expect(gate).toMatchObject({ kind: "final_signoff", status: "approved", auto: true });
    const [notice] = await inboxOf("orchestrator", buildId);
    expect(notice).toMatchObject({ from: "relay", type: "status" });
    expect(notice.body).toBe("Final sign-off auto-approved (final_signoff gate is off). The build is shipped.");
  });
});

describe("work messages outside in_progress", () => {
  it("are refused from agents but question and status are accepted", async () => {
    const build = await createBuild();
    const taskId = await createTask(build.build_id);
    const base = { build_id: build.build_id, body: "x", task_id: taskId };
    await expectError("orchestrator", "send", { ...base, to_role: "dev", type: "task" }, "conflict");
    await expectError("developer", "send", { ...base, to_role: "cd", type: "review_request", links: PREVIEW }, "conflict");
    await expectError("developer", "send", { ...base, to_role: "cd", type: "handoff" }, "conflict");
    await expectError("creative-director", "send", { ...base, to_role: "dev", type: "verdict", verdict: "approved" }, "conflict");
    await send("developer", { ...base, to_role: "orchestrator", type: "question" });
    await send("developer", { ...base, to_role: "orchestrator", type: "status" });

    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    await expectError("orchestrator", "send", { ...base, to_role: "dev", type: "task" }, "conflict");
    await send("creative-director", { ...base, to_role: "orchestrator", type: "question" });
  });

  it("are accepted from the human in any non-terminal status", async () => {
    const build = await createBuild();
    const taskId = await createTask(build.build_id);
    const { task: assigned } = await send("human", {
      build_id: build.build_id,
      to_role: "creative-director",
      type: "task",
      task_id: taskId,
    });
    expect(assigned.owner).toBe("creative-director");
  });
});

describe("orchestrator notices", () => {
  it("tells the orchestrator when someone else closes a task, and asks for sign-off once every task is closed", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const docs = await createTask(buildId, { title: "Docs", reviewer: null });
    await readInbox("orchestrator", buildId);

    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    const approved = await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });
    expect(approved.message.to).toBe("developer");
    const [done] = await readInbox("orchestrator", buildId);
    expect(done).toMatchObject({ from: "relay", to: "orchestrator", type: "status", task_id: taskId, on_behalf_of: null });
    expect(done.body).toBe('T1 "Main screen" is done (approved by creative-director in round 1).');

    await call("developer", "ledger_update", { build_id: buildId, task_id: docs, status: "done" });
    const [last] = await readInbox("orchestrator", buildId);
    expect(last).toMatchObject({ from: "relay", task_id: docs });
    // One message, not two.
    expect(last.body).toBe('T2 "Docs" is done (marked done by developer). Every task is closed: request final_signoff.');
    // Relay notices never count toward the message cap.
    expect((await ledger(buildId)).build.message_count).toBe(2);
  });

  it("reports cancels and blocks by others with the reason, but not the orchestrator's own changes", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const second = await createTask(buildId, { title: "Docs", reviewer: null });
    await readInbox("orchestrator", buildId);

    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked", note: "Waiting for the API key" });
    const [blocked] = await readInbox("orchestrator", buildId);
    expect(blocked).toMatchObject({ from: "relay", type: "status", task_id: taskId });
    expect(blocked.body).toBe("T1 is blocked (developer): Waiting for the API key.");

    await call("human", "ledger_update", { build_id: buildId, task_id: second, status: "cancelled", note: "Out of scope" });
    const [cancelled] = await readInbox("orchestrator", buildId);
    expect(cancelled.body).toBe('T2 "Docs" was cancelled by human: Out of scope.');

    // The orchestrator's own close needs no notice, even when it is the last open task.
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    expect(await readInbox("orchestrator", buildId)).toEqual([]);
  });

  it("says nothing about sign-off while a gate is pending or a task is still open", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    const docs = await createTask(buildId, { title: "Docs", reviewer: null });
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", {
      build_id: buildId,
      to_role: "dev",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Fix contrast"],
    });
    await readInbox("orchestrator", buildId);
    await call("developer", "ledger_update", { build_id: buildId, task_id: docs, status: "done" });
    const [notice] = await readInbox("orchestrator", buildId);
    expect(notice.body).toBe('T2 "Docs" is done (marked done by developer).');
  });
});

describe("build_control", () => {
  it("halts and resumes to the previous status", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    const halted = await call("human", "build_control", { build_id: build.build_id, action: "halt", reason: "Lunch" });
    expect(halted.build).toMatchObject({ status: "halted", status_before_halt: "awaiting_plan_approval", halt_reason: "Lunch" });
    await expectError("human", "build_control", { build_id: build.build_id, action: "halt" }, "conflict");
    await expectError("human", "gate_decide", { build_id: build.build_id, gate_id: "G1", decision: "approved" }, "conflict");
    const resumed = await call("human", "build_control", { build_id: build.build_id, action: "resume" });
    expect(resumed.build).toMatchObject({ status: "awaiting_plan_approval", status_before_halt: null, halt_reason: null });
    await expectError("human", "build_control", { build_id: build.build_id, action: "resume" }, "conflict");
  });

  it("tells the orchestrator and every open task's owner when it resumes or cancels a build", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await createTask(buildId, { title: "Design", assignee: "creative-director", reviewer: null });
    await createTask(buildId, { title: "Approve copy", assignee: "human", reviewer: null });
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    for (const role of ["orchestrator", "creative-director", "developer", "human"] as const) await readInbox(role, buildId);

    await call("human", "build_control", { build_id: buildId, action: "halt", reason: "Lunch" });
    expect(await relayTo(buildId, "orchestrator")).toHaveLength(1); // a halt tells nobody (writes fail with halted)
    await call("human", "build_control", { build_id: buildId, action: "resume" });
    const resumed = "Build resumed by James (was halted: Lunch). Carry on from the ledger.";
    // T1 is in review (owner creative-director), T2 is the creative director's, T3 the human's.
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual([resumed]);
    expect((await readInbox("creative-director", buildId)).map((m: Json) => [m.from, m.type, m.task_id, m.body])).toEqual([
      ["relay", "status", null, resumed],
    ]);
    expect(await readInbox("developer", buildId)).toEqual([]);
    expect(await readInbox("human", buildId)).toEqual([]);

    await call("human", "build_control", { build_id: buildId, action: "cancel", reason: "Changed my mind" });
    const cancelled = "Build cancelled by James: Changed my mind. Stop work on it.";
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual([cancelled]);
    expect((await readInbox("creative-director", buildId)).map((m: Json) => m.body)).toEqual([cancelled]);
    expect(await readInbox("developer", buildId)).toEqual([]);
  });

  it("cancels from any non-terminal status and cancels pending gates", async () => {
    const build = await createBuild();
    await createTask(build.build_id);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    await call("human", "build_control", { build_id: build.build_id, action: "halt" });
    const { build: cancelled } = await call("human", "build_control", { build_id: build.build_id, action: "cancel", reason: "Changed my mind" });
    expect(cancelled.status).toBe("cancelled");
    const snapshot = await ledger(build.build_id);
    expect(snapshot.gates[0].status).toBe("cancelled");
    await expectError("human", "build_control", { build_id: build.build_id, action: "cancel" }, "conflict");
  });

  it("sets caps and carries the review cap to open tasks", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await expectError("human", "build_control", { build_id: buildId, action: "set_caps" }, "invalid_input");
    const { build } = await call("human", "build_control", {
      build_id: buildId,
      action: "set_caps",
      caps: { max_messages: 10, max_review_rounds: 5 },
    });
    expect(build.caps).toEqual({ max_messages: 10, max_review_rounds: 5 });
    expect((await task(buildId, taskId)).max_rounds).toBe(5);
  });
});
