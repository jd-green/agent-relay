import { describe, expect, it } from "vitest";
import {
  PREVIEW,
  buildStub,
  call,
  callRaw,
  createBuild,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  readInbox,
  send,
  useCleanState,
  type Json,
} from "./helpers";

useCleanState();

describe("message cap", () => {
  it("halts the build when an agent would exceed it; human messages do not count", async () => {
    const build = await createBuild({ caps: { max_messages: 3 } });
    const base = { build_id: build.build_id, type: "status", body: "x" };
    for (let i = 0; i < 3; i += 1) await send("human", { ...base, to_role: "developer" });
    await send("developer", { ...base, to_role: "orchestrator" });
    await send("orchestrator", { ...base, to_role: "developer" });
    await send("creative-director", { ...base, to_role: "developer" });

    const message = await expectError("developer", "send", { ...base, to_role: "orchestrator" }, "cap_reached");
    expect(message).toContain("cap of 3");
    const snapshot = await ledger(build.build_id);
    expect(snapshot.build).toMatchObject({ status: "halted", halt_reason: "message cap reached", status_before_halt: "planning", message_count: 3 });
    const notice = snapshot.messages.at(-1);
    expect(notice).toMatchObject({ from: "relay", to: "human", type: "status" });
    expect(notice.body).toContain("cap of 3 agent messages");
    expect(snapshot.messages.filter((m: { from: string }) => m.from === "developer")).toHaveLength(1);

    // Now halted: agents are refused with "halted", the human can still talk.
    await expectError("orchestrator", "send", { ...base, to_role: "developer" }, "halted");
    await send("human", { ...base, to_role: "orchestrator" });

    // Resuming at the cap would halt again on the next agent message, so it is refused until the cap is raised.
    expect(await expectError("human", "build_control", { build_id: build.build_id, action: "resume" }, "conflict")).toContain("set_caps");
    await call("human", "build_control", { build_id: build.build_id, action: "set_caps", caps: { max_messages: 10 } });
    await call("human", "build_control", { build_id: build.build_id, action: "resume" });
    await send("developer", { ...base, to_role: "orchestrator" });
  });
});

describe("atomicity", () => {
  it("never lets concurrent sends overshoot the cap", async () => {
    const build = await createBuild({ caps: { max_messages: 5 } });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        callRaw("developer", "send", { build_id: build.build_id, to_role: "orchestrator", type: "status", body: `burst ${i}` }),
      ),
    );
    const codes = results.map((result) => (result.body.ok ? "ok" : result.body.error.code)).sort();
    expect(codes).toEqual(["cap_reached", "halted", "halted", "ok", "ok", "ok", "ok", "ok"]);
    expect((await ledger(build.build_id)).build).toMatchObject({ status: "halted", message_count: 5 });
  });
});

describe("burst limit", () => {
  it("rate-limits a sender above BURST_PER_MINUTE without halting", async () => {
    const build = await createBuild();
    const base = { build_id: build.build_id, type: "status", body: "x", to_role: "orchestrator" };
    for (let i = 0; i < 10; i += 1) await send("developer", base);
    await expectError("developer", "send", base, "rate_limited");
    // Other senders and the human are unaffected.
    await send("creative-director", base);
    for (let i = 0; i < 12; i += 1) await send("human", { ...base, to_role: "developer" });
    expect((await ledger(build.build_id)).build.status).toBe("planning");
  });

  it("also limits agent ledger_update and gate_request calls, to BURST_PER_MINUTE × 3 per role", async () => {
    const build = await createBuild();
    const taskId = await createTask(build.build_id);
    for (let i = 1; i < 30; i += 1) await call("orchestrator", "ledger_update", { build_id: build.build_id, task_id: taskId, title: `v${i}` });
    const message = await expectError("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" }, "rate_limited");
    expect(message).toContain("limit 30");
    await expectError("orchestrator", "ledger_update", { build_id: build.build_id, task_id: taskId, note: "x" }, "rate_limited");
    // Refused calls change nothing and other roles are unaffected; ledger writes do not count toward the message cap.
    await call("developer", "ledger_update", { build_id: build.build_id, task_id: taskId, note: "still here" });
    await call("human", "ledger_update", { build_id: build.build_id, task_id: taskId, note: "me too" });
    const snapshot = await ledger(build.build_id);
    expect(snapshot.build).toMatchObject({ status: "planning", message_count: 0 });
    expect(snapshot.tasks[0].title).toBe("v29");
  });
});

describe("kill switch", () => {
  it("stops agent writes everywhere but keeps inbox and the human working", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { halted } = await call("human", "kill_switch", { on: true, reason: "Runaway loop" });
    expect(halted).toMatchObject({ global: true, reason: "Runaway loop" });
    expect(halted.at).not.toBeNull();

    await expectError("developer", "send", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW, body: "x" }, "halted");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "halted");
    await expectError("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "x" }, "halted");
    await expectError("orchestrator", "build_create", { title: "x", brief: "y" }, "halted");

    const inbox = await call("orchestrator", "inbox", {});
    expect(inbox.halted).toEqual({ global: true, reason: "Runaway loop", at: halted.at });
    expect(inbox.builds[0].messages.length).toBeGreaterThan(0);
    expect((await call("developer", "whoami")).halted.global).toBe(true);
    await call("developer", "ledger_get", { build_id: buildId });

    await send("human", { build_id: buildId, to_role: "orchestrator", type: "status", body: "Paused everything" });
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, note: "Paused" });

    const cleared = await call("human", "kill_switch", { on: false });
    expect(cleared.halted).toMatchObject({ global: false, reason: null });
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
  });

  it("is checked inside the build itself, so a write that passed the Worker's check before the toggle is refused", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Race" });
    // Calling the BuildDO directly skips the Worker's check, like a request already past it when the switch flipped.
    const stub = buildStub(buildId);
    const input = { build_id: buildId, to_role: "orchestrator", type: "status" as const, body: "late write" };
    const sent = await stub.send("developer", input);
    expect(sent).toEqual({ ok: false, error: { code: "halted", message: "the global kill switch is on (Race); stop and wait for James" } });
    const updated = await stub.updateTask("developer", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(updated.ok ? null : updated.error.code).toBe("halted");
    const gate = await stub.requestGate("orchestrator", { build_id: buildId, kind: "final_signoff", summary: "x" });
    expect(gate.ok ? null : gate.error.code).toBe("halted");
    expect((await stub.send("human", { ...input, to_role: "developer" })).ok).toBe(true);
    // The orchestrator can't start a new build either (RelayDO holds the switch itself).
    await call("human", "build_control", { build_id: buildId, action: "cancel" });
    await expectError("orchestrator", "build_create", { title: "x", brief: "y" }, "halted");

    await call("human", "kill_switch", { on: false });
    const build = await createBuild({ title: "After" });
    expect((await buildStub(build.build_id).send("developer", { ...input, build_id: build.build_id })).ok).toBe(true);
  });

  it("gives a build created while it is on the switch's state", async () => {
    await call("human", "kill_switch", { on: true, reason: "Paused" });
    const build = await createBuild();
    const sent = await buildStub(build.build_id).send("developer", {
      build_id: build.build_id,
      to_role: "orchestrator",
      type: "status",
      body: "x",
    });
    expect(sent.ok ? null : sent.error.code).toBe("halted");
  });

  it("tells the orchestrator and every open task's owner to carry on when it is cleared", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await createTask(buildId, { title: "Approve copy", assignee: "human", reviewer: null });
    await call("human", "kill_switch", { on: true, reason: "Pause" });
    for (const role of ["orchestrator", "developer", "human"] as const) await readInbox(role, buildId);
    // Turning it on again changes nothing for the agents.
    await call("human", "kill_switch", { on: true, reason: "Still paused" });
    expect(await readInbox("orchestrator", buildId)).toEqual([]);

    await call("human", "kill_switch", { on: false });
    const notice = "Relay kill switch cleared by James. Carry on from the ledger.";
    for (const role of ["orchestrator", "developer"] as const) {
      expect((await readInbox(role, buildId)).map((m: Json) => [m.from, m.type, m.task_id, m.body])).toEqual([
        ["relay", "status", null, notice],
      ]);
    }
    expect(await readInbox("human", buildId)).toEqual([]);
    expect((await ledger(buildId)).tasks.find((t: Json) => t.id === taskId).owner).toBe("developer");
  });

  it("does not tell a build that is still halted on its own", async () => {
    const { buildId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true });
    await call("human", "build_control", { build_id: buildId, action: "halt", reason: "Budget" });
    await readInbox("orchestrator", buildId);
    await call("human", "kill_switch", { on: false });
    expect(await readInbox("orchestrator", buildId)).toEqual([]);
  });
});

describe("per-build halt", () => {
  it("refuses agent writes to that build only", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "build_control", { build_id: buildId, action: "halt", reason: "Reviewing costs" });
    const message = await expectError("developer", "send", { build_id: buildId, to_role: "cd", type: "status", body: "x" }, "halted");
    expect(message).toContain("Reviewing costs");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "halted");
    await expectError("orchestrator", "ledger_update", { build_id: buildId, title: "New", assignee: "developer" }, "halted");
    const inbox = await call("developer", "inbox", { build_id: buildId });
    expect(inbox.builds[0].status).toBe("halted");
    expect(inbox.halted.global).toBe(false);
    await send("human", { build_id: buildId, to_role: "developer", type: "status", body: "Hold on" });
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, note: "On hold" });
  });

  it("copies the build's review cap to new tasks", async () => {
    const build = await createBuild({ gates: { plan_approval: false }, caps: { max_review_rounds: 2 } });
    const taskId = await createTask(build.build_id);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    const snapshot = await ledger(build.build_id);
    expect(snapshot.tasks.find((t: { id: string }) => t.id === taskId).max_rounds).toBe(2);
  });
});
