import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  PREVIEW,
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

/** Nudges, their orchestrator copies, blocked-task notices and second-miss escalations (other relay notices left out). */
async function nudges(buildId: string): Promise<Json[]> {
  return (await ledger(buildId)).messages.filter(
    (message: Json) =>
      message.from === "relay" &&
      (/^(Nudge|Nudged|Stalled|No open tasks|Nothing to work on)/.test(message.body) || / has been blocked for /.test(message.body)),
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
    // The human's task is never nudged; with no ready task held by an agent only the idle-build watch runs.
    await runAlarm(buildId);
    expect((await nudges(buildId)).filter((m: Json) => m.task_id !== null)).toEqual([]);

    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "developer", reviewer: null });
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    await backdate(buildId, taskId, 90);
    // Only the idle-build backstop is scheduled now (see below); the done task itself is never nudged.
    expect(await runAlarm(buildId)).toBe(true);
    expect((await nudges(buildId)).filter((m: Json) => m.task_id !== null)).toEqual([]);
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

  it("keeps a task waiting on a cancelled dependency until its depends_on changes", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const later = await createTask(buildId, { title: "Ship", depends_on: [taskId] });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    expect(await task(buildId, later)).toMatchObject({ ready: false, waiting_on: [taskId] });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).filter((m: Json) => m.task_id === later)).toEqual([]); // waiting, so not nudged

    // Dropping the dependency makes it ready, and its idle clock starts then (not 31 minutes ago).
    const { task: ready } = await call("orchestrator", "ledger_update", { build_id: buildId, task_id: later, depends_on: [] });
    expect(ready).toMatchObject({ ready: true, waiting_on: [], nudge_count: 0 });
    expect(Date.now() - Date.parse(ready.last_activity_at)).toBeLessThan(MINUTE);
    await runAlarm(buildId);
    expect((await nudges(buildId)).filter((m: Json) => m.task_id === later)).toEqual([]);
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).filter((m: Json) => m.task_id === later).map((m: Json) => m.to)).toEqual(["developer", "orchestrator"]);
  });

  it("restarts a dependent's clock when the human turns a cancelled dependency into a done one", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const later = await createTask(buildId, { title: "Ship", depends_on: [taskId] });
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    await timeTravel(buildId, 31);
    const before = Date.now();
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    const ready = await task(buildId, later);
    expect(ready).toMatchObject({ ready: true, waiting_on: [] });
    expect(Date.parse(ready.last_activity_at)).toBeGreaterThanOrEqual(before);
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

describe("nudge wording by status", () => {
  it("asks a reviewer for its verdict, never to hand the task off", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const [nudge, copy] = await nudges(buildId);
    expect(nudge).toMatchObject({ to: "creative-director", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(nudge.body).toBe(
      'Nudge: T1 "Main screen" has been waiting on your review for 31 min. Send your verdict to developer (or a question if a link won\'t open).',
    );
    expect(copy).toMatchObject({ to: "orchestrator", task_id: taskId });
    expect(copy.body).toBe('Nudged creative-director: T1 "Main screen" has been waiting on its review for 31 min.');
  });

  it("asks the orchestrator to act on its own task or note where it stands, not to message itself", async () => {
    const { buildId } = await inProgressBuild();
    const own = await createTask(buildId, { title: "Plan the copy", assignee: "orchestrator", reviewer: null });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const toOrchestrator = (await nudges(buildId)).filter((m: Json) => m.task_id === own);
    expect(toOrchestrator.map((m: Json) => [m.to, m.body])).toEqual([
      [
        "orchestrator",
        'Nudge: T2 "Plan the copy" has been idle for 31 min. You own it (status todo): act on it, or record where it stands with a ledger_update note.',
      ],
    ]);
  });

  it("words each task of a grouped nudge by its status", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const logo = await createTask(buildId, { title: "Logo", assignee: "creative-director", reviewer: "developer" });
    await send("creative-director", { build_id: buildId, to_role: "developer", type: "review_request", task_id: logo, links: PREVIEW });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const [nudge, copy] = await nudges(buildId);
    expect(nudge).toMatchObject({ to: "developer", task_id: taskId });
    const list = 'T1 "Main screen" (todo, idle 31 min); T2 "Logo" (in_review, waiting on your review for 31 min)';
    expect(nudge.body).toBe(
      `Nudge: 2 tasks are waiting on you: ${list}. ` +
        "T1: post progress with send (type status), update it with ledger_update, or hand it off. " +
        "T2: send your verdict to creative-director (or a question if a link won't open).",
    );
    expect(copy.body).toBe(`Nudged developer about 2 tasks: ${list}.`);
  });
});

describe("who holds the next step", () => {
  it("tells the orchestrator, not the owner, about a blocked task, then James after another interval", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked", note: "Waiting on the\nAPI key" });
    const blockedNotice = 'T1 is blocked (developer). Their note: "Waiting on the API key"';
    expect((await relayTo(buildId, "orchestrator")).map((m: Json) => m.body)).toContain(blockedNotice);

    await timeTravel(buildId, 31);
    // The developer writing elsewhere doesn't make the task less stuck.
    await send("developer", { build_id: buildId, to_role: "orchestrator", type: "question", body: "Any news on the key?" });
    await runAlarm(buildId);
    const [notice] = await nudges(buildId);
    expect(notice).toMatchObject({ from: "relay", to: "orchestrator", type: "status", task_id: taskId, on_behalf_of: null });
    expect(notice.body).toBe('T1 "Main screen" has been blocked for 31 min (developer). Their note: "Waiting on the API key"');
    expect(await relayTo(buildId, "developer")).toEqual([]);
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 1, stalled: false });

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const stalled = (await nudges(buildId)).slice(1);
    expect(stalled.map((m: Json) => [m.to, m.on_behalf_of])).toEqual([
      ["human", "orchestrator"],
      ["orchestrator", null],
    ]);
    expect(stalled[0].body).toBe('Stalled: T1 blocked for 62 min ("Main screen", developer). Their note: "Waiting on the API key"');
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 2, stalled: true });
    const audit = (await ledger(buildId)).audit.map((row: Json) => [row.action, row.target, row.detail?.reason]);
    expect(audit).toEqual(expect.arrayContaining([["nudge.sent", taskId, "blocked"], ["nudge.escalated", taskId, "blocked"]]));

    // Unblocked: the watch ends, and the owner's ordinary nudge clock starts now.
    await timeTravel(buildId, 120);
    expect(await runAlarm(buildId)).toBe(false);
    const { task: moving } = await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(moving).toMatchObject({ nudge_count: 0, stalled: false });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).slice(3).map((m: Json) => m.to)).toEqual(["developer", "orchestrator"]);
  });

  it("keeps a blocked task's clock running through its owner's messages and notes about it", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked", note: "No API key" });
    await timeTravel(buildId, 20);
    await send("developer", { build_id: buildId, to_role: "orchestrator", type: "status", task_id: taskId, body: "Still blocked on T1" });
    const { task: noted } = await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, note: "Asked James too" });
    expect(Date.now() - Date.parse(noted.last_activity_at)).toBeGreaterThanOrEqual(20 * MINUTE);
    await timeTravel(buildId, 11);
    await runAlarm(buildId);
    const [notice] = await nudges(buildId);
    expect(notice).toMatchObject({ to: "orchestrator", task_id: taskId });
    expect(notice.body).toBe('T1 "Main screen" has been blocked for 31 min (developer). Their note: "Asked James too"');
  });

  it("starts a fresh watch when a task message sends a blocked task back to the same owner", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "blocked" });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 1 });
    const { task: unblocked } = await send("orchestrator", {
      build_id: buildId,
      to_role: "developer",
      type: "task",
      task_id: taskId,
      body: "The key is in the vault now; carry on.",
    });
    expect(unblocked).toMatchObject({ status: "todo", owner: "developer", nudge_count: 0 });
    expect(Date.now() - Date.parse(unblocked.last_activity_at)).toBeLessThan(MINUTE);
    // The developer was never nudged about T1, so the next interval brings a first nudge, not a "Stalled" report.
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const later = (await nudges(buildId)).slice(1);
    expect(later.map((m: Json) => [m.to, m.body.split(":")[0]])).toEqual([
      ["developer", "Nudge"],
      ["orchestrator", "Nudged developer"],
    ]);
  });

  it("nudges the assignee, not the reviewer, while the reviewer waits on its answer", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "developer", type: "question", task_id: taskId, body: "The preview 404s; working link?" });
    await timeTravel(buildId, 31);
    // The reviewer's writes elsewhere don't matter: the developer owes the next step.
    await call("creative-director", "ledger_update", { build_id: buildId, task_id: taskId, note: "Waiting on a working link" });
    await runAlarm(buildId);
    const [nudge, copy] = await nudges(buildId);
    expect(nudge).toMatchObject({ to: "developer", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(nudge.body).toBe(
      'Nudge: creative-director asked you about T1 "Main screen" 31 min ago and is waiting on your answer to review it. ' +
        "Reply to creative-director with send (task_id T1), e.g. a status with a working link.",
    );
    expect(copy.body).toBe('Nudged developer: creative-director has been waiting 31 min for its answer about T1 "Main screen".');

    // The answer restarts the clock, and it is the reviewer's turn again.
    const { task: answered } = await send("developer", {
      build_id: buildId,
      to_role: "creative-director",
      type: "status",
      task_id: taskId,
      body: "Try this one.",
      links: [{ url: "https://preview.example.com/working" }],
    });
    expect(answered).toMatchObject({ status: "in_review", owner: "creative-director", nudge_count: 0 });
    expect(Date.now() - Date.parse(answered.last_activity_at)).toBeLessThan(MINUTE);
    await runAlarm(buildId);
    expect(await nudges(buildId)).toHaveLength(2);
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const later = (await nudges(buildId)).slice(2);
    expect(later.map((m: Json) => m.to)).toEqual(["creative-director", "orchestrator"]);
    expect(later[0].body).toMatch(/^Nudge: T1 "Main screen" has been waiting on your review for 31 min\./);
  });

  it("lets the developer's activity answer a nudge about an answer it owes", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "developer", type: "question", task_id: taskId, body: "Link?" });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 1 });
    await send("developer", { build_id: buildId, to_role: "orchestrator", type: "status", body: "On it" });
    expect(await task(buildId, taskId)).toMatchObject({ nudge_count: 0, stalled: false });
  });
});

describe("idle-build backstop with open tasks", () => {
  it("nudges the orchestrator when no agent holds a ready task, naming what holds the rest up", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const ship = await createTask(buildId, { title: "Ship", depends_on: [taskId] });
    const copy = await createTask(buildId, { title: "Copy", assignee: "human", reviewer: null });
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled", note: "Dropped" });
    expect(await task(buildId, ship)).toMatchObject({ ready: false, waiting_on: [taskId] });

    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const [nudge] = await nudges(buildId);
    expect(nudge).toMatchObject({ to: "orchestrator", task_id: null });
    expect(nudge.body).toBe(
      `Nothing to work on for 31 min: no agent holds a ready open task (T2 "Ship" waits on T1 (cancelled); T3 "Copy" is with James). ` +
        "Assign ready work, fix depends_on, or cancel what is no longer needed.",
    );
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    const [stalled] = (await nudges(buildId)).slice(1);
    expect(stalled).toMatchObject({ to: "human" });
    expect(stalled.body).toBe('Stalled: orchestrator missed two nudges on "Tip calculator": no agent has had a ready task for 62 min.');

    // Re-pointing the dependency makes T2 ready for the developer: the watch ends and T2's own clock starts.
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: ship, depends_on: [copy] });
    await call("human", "ledger_update", { build_id: buildId, task_id: copy, status: "done" });
    await timeTravel(buildId, 31);
    await runAlarm(buildId);
    expect((await nudges(buildId)).slice(3).map((m: Json) => [m.to, m.task_id])).toEqual([
      ["developer", ship],
      ["orchestrator", ship],
    ]);
  });
});
