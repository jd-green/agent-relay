import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  buildSql,
  buildStub,
  call,
  createTask,
  inProgressBuild,
  ledger,
  relayTo,
  runAlarm,
  send,
  task,
  timeTravel,
  useCleanState,
  type Json,
} from "./helpers";

useCleanState();

const MINUTE = 60_000;
const NUDGE_AFTER = 30 * MINUTE;

/** Moves a task's idle clocks back in time (no test-only code paths in the Worker). */
async function backdate(buildId: string, taskId: string, minutes: number) {
  const shift = minutes * MINUTE;
  await buildSql(
    buildId,
    "UPDATE tasks SET last_activity_ms = last_activity_ms - ?, last_nudge_ms = last_nudge_ms - ? WHERE num = ?",
    shift,
    shift,
    Number(taskId.slice(1)),
  );
}

/** Nudges, their orchestrator copies and second-miss escalations (other relay notices left out). */
async function nudges(buildId: string): Promise<Json[]> {
  return (await ledger(buildId)).messages.filter(
    (message: Json) => message.from === "relay" && /^(Nudge|Nudged|Stalled|No open tasks)/.test(message.body),
  );
}

const alarmAt = (buildId: string) => runInDurableObject(buildStub(buildId), (_instance, state) => state.storage.getAlarm());

describe("nudges", () => {
  it("schedules the alarm for the earliest idle deadline", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { last_activity_at } = await task(buildId, taskId);
    expect(await alarmAt(buildId)).toBe(Date.parse(last_activity_at) + NUDGE_AFTER);
  });

  it("nudges an idle owner once, then escalates after a second miss", async () => {
    const { buildId, taskId } = await inProgressBuild();
    expect(await runAlarm(buildId)).toBe(true);
    expect(await nudges(buildId)).toEqual([]); // not idle long enough yet

    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    const sent = await nudges(buildId);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ to: "developer", type: "status", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(sent[0].body).toMatch(/^Nudge: T1 "Main screen" has been idle for 31 min/);
    expect(sent[1]).toMatchObject({ to: "orchestrator", type: "status", task_id: taskId });
    const nudged = await task(buildId, taskId);
    expect(nudged).toMatchObject({ nudge_count: 1, stalled: false });
    expect(nudged.last_nudge_at).not.toBeNull();

    // Running again before the second deadline does nothing.
    await runAlarm(buildId);
    expect(await nudges(buildId)).toHaveLength(2);

    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    const escalations = (await nudges(buildId)).slice(2);
    expect(escalations.map((message: Json) => message.to)).toEqual(["human", "orchestrator"]);
    expect(escalations[0].body).toContain("developer missed two nudges on T1");
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 2, stalled: true });
    const { builds } = await call("human", "build_list");
    expect(builds[0].last_message.excerpt).toContain("missed two nudges");

    // No further nudges until there is activity; the alarm is cleared.
    await backdate(buildId, taskId, 120);
    expect(await runAlarm(buildId)).toBe(false);
    expect(await nudges(buildId)).toHaveLength(4);
  });

  it("resets on a message from the owner", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    expect((await task(buildId, taskId)).stalled).toBe(true);

    await send("developer", { build_id: buildId, to_role: "orchestrator", type: "status", task_id: taskId, body: "Working on it" });
    const active = await task(buildId, taskId);
    expect(active).toMatchObject({ nudge_count: 0, stalled: false, last_nudge_at: null });
    expect(Date.now() - Date.parse(active.last_activity_at)).toBeLessThan(MINUTE);
  });

  it("resets on a ledger_update by the owner but not by others", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, note: "Checking in" });
    expect((await task(buildId, taskId)).nudge_count).toBe(1);
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect((await task(buildId, taskId)).nudge_count).toBe(0);
  });

  it("resets for the new owner on every ownership change", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    await send("orchestrator", { build_id: buildId, to_role: "creative-director", type: "task", task_id: taskId });
    expect(await task(buildId, taskId)).toMatchObject({ owner: "creative-director", nudge_count: 0 });
  });

  it("does not nudge in a halted build, and restarts the clock on resume", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "build_control", { build_id: buildId, action: "halt" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(false);
    expect(await nudges(buildId)).toEqual([]);

    await call("human", "build_control", { build_id: buildId, action: "resume" });
    await runAlarm(buildId);
    expect(await nudges(buildId)).toEqual([]);
  });

  it("does not nudge while the kill switch is on", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Testing" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(true);
    expect(await nudges(buildId)).toEqual([]);

    // Clearing the switch restarts the idle clocks, so nobody is nudged for the paused time.
    await call("human", "kill_switch", { on: false });
    await runAlarm(buildId);
    expect(await nudges(buildId)).toEqual([]);
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    expect(await nudges(buildId)).toHaveLength(2);
  });

  it("skips tasks owned by the human and closed tasks", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "human" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(false);

    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "developer", reviewer: null });
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    await backdate(buildId, taskId, 90);
    // Only the idle-build backstop is scheduled now (see below); the done task itself is never nudged.
    expect(await runAlarm(buildId)).toBe(true);
    expect(await nudges(buildId)).toEqual([]);
  });
});

describe("nudge eligibility (ready tasks, quiet owners)", () => {
  it("watches a task only once every depends_on task is closed, and starts its clock then", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: null });
    const later = await createTask(buildId, { title: "Ship", assignee: "creative-director", reviewer: null, depends_on: [taskId] });
    expect(await task(buildId, later)).toMatchObject({ ready: false, waiting_on: [taskId] });

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).map((m: Json) => [m.to, m.task_id])).toEqual([
      ["developer", taskId],
      ["orchestrator", taskId],
    ]);
    expect((await task(buildId, later)).nudge_count).toBe(0); // waiting on T1, so not nudged

    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    const ready = await task(buildId, later);
    expect(ready).toMatchObject({ ready: true, waiting_on: [], nudge_count: 0 });
    expect(Date.now() - Date.parse(ready.last_activity_at)).toBeLessThan(MINUTE); // the clock restarted

    await runAlarm(buildId);
    expect(await nudges(buildId)).toHaveLength(2);
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const toCd = (await nudges(buildId)).slice(2);
    expect(toCd.map((m: Json) => [m.to, m.task_id])).toEqual([
      ["creative-director", later],
      ["orchestrator", later],
    ]);
  });

  it("cancelled dependencies count as closed", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const later = await createTask(buildId, { title: "Ship", depends_on: [taskId] });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    expect(await task(buildId, later)).toMatchObject({ ready: true, waiting_on: [] });
  });

  it("leaves an owner alone while it is active anywhere in the build, then sends one nudge for all its idle tasks", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const second = await createTask(buildId, { title: "Settings screen" });
    await backdate(buildId, second, 31);
    // The developer keeps writing on T1, so T2 (idle for 31 min) is not nudged.
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    await runAlarm(buildId);
    expect(await nudges(buildId)).toEqual([]);

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const sent = await nudges(buildId);
    expect(sent.map((m: Json) => m.to)).toEqual(["developer", "orchestrator"]);
    expect(sent[0]).toMatchObject({ task_id: taskId, on_behalf_of: "orchestrator" });
    expect(sent[0].body).toMatch(/^Nudge: you own 2 idle tasks: T1 "Main screen" \(in_progress, idle 31 min\); T2 "Settings screen" \(todo, idle 62 min\)/);
    expect(sent[1].body).toContain("Nudged developer about 2 idle tasks");
    for (const id of [taskId, second]) expect(await task(buildId, id)).toMatchObject({ nudge_count: 1 });

    // One second-miss escalation for both.
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const escalations = (await nudges(buildId)).slice(2);
    expect(escalations.map((m: Json) => m.to)).toEqual(["human", "orchestrator"]);
    expect(escalations[0].body).toBe('Stalled: developer missed two nudges on T1 "Main screen", T2 "Settings screen" (idle for 93 min).');
    for (const id of [taskId, second]) expect(await task(buildId, id)).toMatchObject({ nudge_count: 2, stalled: true });
  });

  it("counts any write by the owner as the answer to its nudges", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 1 });
    // A message about nothing in particular still shows the developer is there.
    await send("developer", { build_id: buildId, to_role: "orchestrator", type: "question", body: "Which font?" });
    const answered = await task(buildId, taskId);
    expect(answered).toMatchObject({ nudge_count: 0, stalled: false, last_nudge_at: null });
    // The task's own idle clock is unchanged, so the next nudge comes NUDGE_AFTER after the owner's last write.
    await runAlarm(buildId);
    expect(await nudges(buildId)).toHaveLength(2);
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).slice(2).map((m: Json) => m.to)).toEqual(["developer", "orchestrator"]);
  });
});

describe("idle-build backstop (no open task, no pending gate)", () => {
  async function allClosed() {
    const built = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: built.buildId, task_id: built.taskId, reviewer: null });
    await call("developer", "ledger_update", { build_id: built.buildId, task_id: built.taskId, status: "done" });
    return built;
  }

  it("nudges the orchestrator, then tells the human after a second miss", async () => {
    const { buildId } = await allClosed();
    await runAlarm(buildId);
    expect(await nudges(buildId)).toEqual([]);

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const [nudge] = await nudges(buildId);
    expect(nudge).toMatchObject({ from: "relay", to: "orchestrator", type: "status", task_id: null, on_behalf_of: null });
    expect(nudge.body).toBe("No open tasks for 31 min: request final_signoff or add tasks.");

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const stalled = (await nudges(buildId)).slice(1);
    expect(stalled.map((m: Json) => m.to)).toEqual(["human", "orchestrator"]);
    expect(stalled[0].body).toMatch(/^Stalled: orchestrator missed two nudges on "Tip calculator": no open tasks for 62 min/);
    const audit = (await ledger(buildId)).audit.map((row: Json) => [row.actor, row.action, row.target]);
    expect(audit).toEqual(expect.arrayContaining([["relay", "nudge.sent", buildId], ["relay", "nudge.escalated", buildId]]));

    // Nothing more until the orchestrator writes; its write answers the nudges.
    await timeTravel(buildId, 120);
    expect(await runAlarm(buildId)).toBe(false);
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: "T1", note: "Checking the preview first" });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).slice(3).map((m: Json) => m.to)).toEqual(["orchestrator"]);
  });

  it("stops once final sign-off is requested or a task is added", async () => {
    const { buildId } = await allClosed();
    await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "Done" });
    await timeTravel(buildId, 90);
    expect(await runAlarm(buildId)).toBe(false);

    await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "rejected" });
    await createTask(buildId, { title: "README" });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).map((m: Json) => m.to)).toEqual(["developer", "orchestrator"]);
    expect((await nudges(buildId)).every((m: Json) => m.task_id === "T2")).toBe(true);
  });

  it("is paused by a halt and restarts on resume", async () => {
    const { buildId } = await allClosed();
    await call("human", "build_control", { build_id: buildId, action: "halt" });
    await timeTravel(buildId, 90);
    expect(await runAlarm(buildId)).toBe(false);
    await call("human", "build_control", { build_id: buildId, action: "resume" });
    await runAlarm(buildId);
    expect(await nudges(buildId)).toEqual([]);
    expect((await relayTo(buildId, "orchestrator")).at(-1).body).toMatch(/^Build resumed by James/);
  });
});
