import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildSql, buildStub, call, inProgressBuild, ledger, runAlarm, send, task, useCleanState, type Json } from "./helpers";

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

async function relayMessages(buildId: string): Promise<Json[]> {
  return (await ledger(buildId)).messages.filter((message: Json) => message.from === "relay");
}

describe("nudges", () => {
  it("schedules the alarm for the earliest idle deadline", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { last_activity_at } = await task(buildId, taskId);
    const alarm = await runInDurableObject(buildStub(buildId), (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(Date.parse(last_activity_at) + NUDGE_AFTER);
  });

  it("nudges an idle owner once, then escalates after a second miss", async () => {
    const { buildId, taskId } = await inProgressBuild();
    expect(await runAlarm(buildId)).toBe(true);
    expect(await relayMessages(buildId)).toEqual([]); // not idle long enough yet

    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    const nudges = await relayMessages(buildId);
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toMatchObject({ to: "developer", type: "status", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(nudges[0].body).toMatch(/^Nudge: T1 "Main screen" has been idle for 31 min/);
    expect(nudges[1]).toMatchObject({ to: "orchestrator", type: "status", task_id: taskId });
    const nudged = await task(buildId, taskId);
    expect(nudged).toMatchObject({ nudge_count: 1, stalled: false });
    expect(nudged.last_nudge_at).not.toBeNull();

    // Running again before the second deadline does nothing.
    await runAlarm(buildId);
    expect(await relayMessages(buildId)).toHaveLength(2);

    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    const escalations = (await relayMessages(buildId)).slice(2);
    expect(escalations.map((message: Json) => message.to)).toEqual(["human", "orchestrator"]);
    expect(escalations[0].body).toContain("developer missed two nudges on T1");
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 2, stalled: true });
    const { builds } = await call("human", "build_list");
    expect(builds[0].last_message.excerpt).toContain("missed two nudges");

    // No further nudges until there is activity; the alarm is cleared.
    await backdate(buildId, taskId, 120);
    expect(await runAlarm(buildId)).toBe(false);
    expect(await relayMessages(buildId)).toHaveLength(4);
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
    expect(await relayMessages(buildId)).toEqual([]);

    await call("human", "build_control", { build_id: buildId, action: "resume" });
    await runAlarm(buildId);
    expect(await relayMessages(buildId)).toEqual([]);
  });

  it("does not nudge while the kill switch is on", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Testing" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(true);
    expect(await relayMessages(buildId)).toEqual([]);

    // Clearing the switch restarts the idle clocks, so nobody is nudged for the paused time.
    await call("human", "kill_switch", { on: false });
    await runAlarm(buildId);
    expect(await relayMessages(buildId)).toEqual([]);
    await backdate(buildId, taskId, 31);
    await runAlarm(buildId);
    expect(await relayMessages(buildId)).toHaveLength(2);
  });

  it("skips tasks owned by the human, done tasks and builds not in progress", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "human" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(false);

    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "developer", reviewer: null });
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    await backdate(buildId, taskId, 90);
    expect(await runAlarm(buildId)).toBe(false);
    expect(await relayMessages(buildId)).toEqual([]);
  });
});
