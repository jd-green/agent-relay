import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { KillState } from "../../src/model";
import type { RelayDO } from "../../src/relay-do";
import {
  PREVIEW,
  buildSql,
  buildStub,
  call,
  callRaw,
  createBuild,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  readInbox,
  relaySql,
  relayStub,
  runAlarm,
  send,
  timeTravel,
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

describe("ledger write cap", () => {
  it("halts the build when agent ledger_update and gate_request calls reach 3 × max_messages", async () => {
    const build = await createBuild({ caps: { max_messages: 2 } });
    const buildId = build.build_id;
    const taskId = await createTask(buildId); // 1
    for (let i = 2; i <= 6; i += 1) await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, note: `step ${i}` });
    // The human's writes don't count.
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, note: "mine" });
    expect((await ledger(buildId)).build).toMatchObject({ write_count: 6, message_count: 0, status: "planning" });

    const message = await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "cap_reached");
    expect(message).toBe(
      `build ${buildId} reached its cap of 6 agent ledger writes (ledger_update and gate_request, 3 × max_messages); it is now halted and James has been told`,
    );
    const snapshot = await ledger(buildId);
    expect(snapshot.build).toMatchObject({ status: "halted", halt_reason: "ledger write cap reached", status_before_halt: "planning", write_count: 6 });
    const notice = snapshot.messages.at(-1);
    expect(notice).toMatchObject({ from: "relay", to: "human", type: "status" });
    expect(notice.body).toBe(
      `Build "Tip calculator" (${buildId}) is halted: it reached its cap of 6 agent ledger writes (ledger_update and gate_request, ` +
        "3 × max_messages; last attempt by developer). Raise max_messages with build_control set_caps, then resume it.",
    );
    await expectError("orchestrator", "gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan" }, "halted");

    // Resuming at the cap would halt again, so it waits for a higher max_messages.
    const refused = await expectError("human", "build_control", { build_id: buildId, action: "resume" }, "conflict");
    expect(refused).toBe(`build ${buildId} is at its ledger write cap (6, 3 × max_messages); raise max_messages with set_caps first`);
    await call("human", "build_control", { build_id: buildId, action: "set_caps", caps: { max_messages: 3 } });
    await call("human", "build_control", { build_id: buildId, action: "resume" });
    await call("orchestrator", "gate_request", { build_id: buildId, kind: "plan_approval", summary: "Plan" });
    expect((await ledger(buildId)).build.write_count).toBe(7);
  });
});

describe("notice coalescing", () => {
  it("sends one blocked notice per task per NUDGE_AFTER_MINUTES and audits the rest", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await readInbox("orchestrator", buildId);
    for (let i = 0; i < 5; i += 1) {
      await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked", note: `try ${i}` });
      await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    }
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual(['T1 is blocked (developer). Their note: "try 0"']);
    const suppressed = (await ledger(buildId)).audit.filter((row: Json) => row.action === "notice.suppressed");
    expect(suppressed).toHaveLength(4);
    expect(suppressed[0]).toMatchObject({ actor: "relay", target: taskId, detail: { kind: "blocked", body: 'T1 is blocked (developer). Their note: "try 1"' } });

    await timeTravel(buildId, 31);
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked", note: "again" });
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual(['T1 is blocked (developer). Their note: "again"']);
  });

  it("sends one done notice per task per NUDGE_AFTER_MINUTES, so a done/reopen loop can't flood the orchestrator", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: null });
    await readInbox("orchestrator", buildId);
    for (let i = 0; i < 3; i += 1) {
      await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
      await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "todo" });
    }
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual([
      'T1 "Main screen" is done (marked done by developer). Every task is closed: request final_signoff.',
    ]);
    expect((await ledger(buildId)).audit.filter((row: Json) => row.action === "notice.suppressed")).toHaveLength(2);
  });
});

/** Makes RelayDO's kill switch push to `buildId` fail while `fn` runs (the build is unreachable). */
async function withFailedPush<T>(buildId: string, fn: (relay: RelayDO) => Promise<T>): Promise<T> {
  return runInDurableObject(relayStub(), async (instance) => {
    const relay = instance as unknown as RelayDO & { pushKill(id: string, state: KillState): Promise<number> };
    const original = relay.pushKill;
    relay.pushKill = async (id: string, state: KillState) => {
      if (id === buildId) throw new Error("build unreachable");
      return original.call(relay, id, state);
    };
    try {
      return await fn(relay);
    } finally {
      relay.pushKill = original;
    }
  });
}

const localKill = async (buildId: string) =>
  ((await buildSql(buildId, "SELECT global_halted, kill_epoch FROM local_state")) as Json[])[0];
const relayAlarm = () => runInDurableObject(relayStub(), (_instance, state) => state.storage.getAlarm());

describe("kill switch epochs", () => {
  it("retries a failed push from RelayDO's alarm until the build acknowledges it", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const before = Date.now();
    await withFailedPush(buildId, (relay) => relay.setKillSwitch("human", true, "Paused"));
    expect(await localKill(buildId)).toEqual({ global_halted: 0, kill_epoch: 0 });
    expect(await relaySql("SELECT kill_epoch FROM builds WHERE build_id = ?", buildId)).toEqual([{ kill_epoch: 0 }]);
    const alarm = await relayAlarm();
    expect(alarm).toBeGreaterThan(before);
    expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);
    // The Worker's own check still refuses agents meanwhile.
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "halted");

    expect(await runDurableObjectAlarm(relayStub())).toBe(true);
    expect(await localKill(buildId)).toEqual({ global_halted: 1, kill_epoch: 1 });
    expect(await relaySql("SELECT kill_epoch FROM builds WHERE build_id = ?", buildId)).toEqual([{ kill_epoch: 1 }]);
    expect(await relayAlarm()).toBeNull();
    // Now the build refuses a write that skipped the Worker's check.
    const late = await buildStub(buildId).updateTask("developer", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(late.ok ? null : late.error.code).toBe("halted");
  });

  it("lets a build that missed the 'off' catch up from the next write through the Worker, telling everyone once", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Paused" });
    await withFailedPush(buildId, (relay) => relay.setKillSwitch("human", false));
    expect(await localKill(buildId)).toEqual({ global_halted: 1, kill_epoch: 1 });
    await readInbox("orchestrator", buildId);
    // A request that skipped the Worker still sees the build's (stale) copy…
    const stale = await buildStub(buildId).send("developer", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x" });
    expect(stale.ok ? null : stale.error.code).toBe("halted");

    // …but a write through the Worker carries the newer read, so the build adopts it before checking.
    const { task: moving } = await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(moving.status).toBe("in_progress");
    expect(await localKill(buildId)).toEqual({ global_halted: 0, kill_epoch: 2 });
    const cleared = "Relay kill switch cleared by James. Carry on from the ledger.";
    expect((await readInbox("orchestrator", buildId)).map((m: Json) => m.body)).toEqual([cleared]);
    expect((await readInbox("developer", buildId)).map((m: Json) => m.body)).toEqual([cleared]);

    // RelayDO's retry finds the build already there: no second notice.
    await runDurableObjectAlarm(relayStub());
    expect(await relaySql("SELECT kill_epoch FROM builds WHERE build_id = ?", buildId)).toEqual([{ kill_epoch: 2 }]);
    expect(await readInbox("orchestrator", buildId)).toEqual([]);
  });

  it("never replaces a newer copy with an older one: a late push, a stale read passed with a write, or the alarm's read", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Paused" });
    await call("human", "kill_switch", { on: false });
    const stub = buildStub(buildId);
    const staleOn: KillState = { halted: { global: true, reason: "Paused", at: new Date().toISOString() }, epoch: 1, by: "human", cleared: false };
    expect(await stub.setGlobalHalt(staleOn)).toBe(2);
    const sent = await stub.send("developer", { build_id: buildId, to_role: "orchestrator", type: "status", body: "x" }, staleOn);
    expect(sent.ok).toBe(true);
    expect(await localKill(buildId)).toEqual({ global_halted: 0, kill_epoch: 2 });

    // A build whose copy is newer than what the alarm reads keeps it (here: on), and sends no nudges.
    await buildSql(buildId, "UPDATE local_state SET global_halted = 1, global_halt_reason = 'Newer', kill_epoch = 9");
    await timeTravel(buildId, 90);
    await runAlarm(buildId);
    expect(await localKill(buildId)).toEqual({ global_halted: 1, kill_epoch: 9 });
    expect((await ledger(buildId)).messages.filter((m: Json) => /^Nudge/.test(m.body))).toEqual([]);
    const update = await stub.updateTask("developer", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(update.ok ? null : update.error.code).toBe("halted");
  });

  it("records the epoch a new build starts with, so a toggle during its creation is retried", async () => {
    await call("human", "kill_switch", { on: true, reason: "Paused" });
    const build = await createBuild();
    expect(await localKill(build.build_id)).toEqual({ global_halted: 1, kill_epoch: 1 });
    expect(await relaySql("SELECT kill_epoch FROM builds WHERE build_id = ?", build.build_id)).toEqual([{ kill_epoch: 1 }]);
    expect(await relayAlarm()).toBeNull();
  });
});
