import { describe, expect, it } from "vitest";
import {
  PREVIEW,
  buildSql,
  call,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  readInbox,
  send,
  task,
  useCleanState,
  type Json,
} from "./helpers";

useCleanState();

async function requestReview(buildId: string, taskId: string) {
  return send("developer", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: taskId, links: PREVIEW });
}

async function requestChanges(buildId: string, taskId: string, changes = ["Increase contrast", "Align the buttons"]) {
  return send("creative-director", {
    build_id: buildId,
    to_role: "developer",
    type: "verdict",
    task_id: taskId,
    verdict: "changes_requested",
    changes,
  });
}

async function unread(role: "human" | "orchestrator" | "developer" | "creative-director", buildId: string): Promise<Json[]> {
  return (await call(role, "inbox", { build_id: buildId })).builds[0].messages;
}

describe("review loop", () => {
  it("moves ownership between developer and reviewer until approval", async () => {
    const { buildId, taskId } = await inProgressBuild();

    const first = await requestReview(buildId, taskId);
    expect(first.task).toMatchObject({ status: "in_review", round: 1, reviewer: "creative-director", owner: "creative-director" });
    expect(first.task.artifacts).toEqual(PREVIEW);

    const changes = await requestChanges(buildId, taskId);
    expect(changes.message).toMatchObject({ type: "verdict", verdict: "changes_requested", changes: ["Increase contrast", "Align the buttons"] });
    expect(changes.task).toMatchObject({ status: "changes_requested", owner: "developer", round: 1 });

    const second = await requestReview(buildId, taskId);
    expect(second.task).toMatchObject({ status: "in_review", round: 2 });
    const approved = await send("creative-director", {
      build_id: buildId,
      to_role: "developer",
      type: "verdict",
      task_id: taskId,
      verdict: "approved",
    });
    expect(approved.task).toMatchObject({ status: "done", owner: null, round: 2 });

    const { verdicts } = await ledger(buildId);
    expect(verdicts).toEqual([
      expect.objectContaining({ id: "V1", task_id: taskId, round: 1, verdict: "changes_requested", reviewer: "creative-director", message_id: changes.message.id }),
      expect.objectContaining({ id: "V2", task_id: taskId, round: 2, verdict: "approved", changes: null, message_id: approved.message.id }),
    ]);
  });

  it("escalates to the human when the review cap is reached", async () => {
    const { buildId, taskId } = await inProgressBuild();
    for (let round = 1; round <= 2; round += 1) {
      await requestReview(buildId, taskId);
      await requestChanges(buildId, taskId);
    }
    await requestReview(buildId, taskId);
    const third = await requestChanges(buildId, taskId, ["Still too dark"]);
    expect(third.task).toMatchObject({ status: "blocked", escalated: true, owner: "human", round: 3, max_rounds: 3 });
    expect(third.gate).toMatchObject({ id: "G2", kind: "escalation", status: "pending", task_id: taskId, requested_by: "relay" });

    const [question] = await unread("human", buildId);
    expect(question).toMatchObject({ from: "relay", type: "question", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(question.body).toContain("3 review rounds");
    expect(question.body).toContain("1. Still too dark");
    const orchestratorNotice = (await unread("orchestrator", buildId)).at(-1);
    expect(orchestratorNotice).toMatchObject({ from: "relay", type: "status", task_id: taskId });
    expect(orchestratorNotice.body).toContain("G2");
    // The assignee hears it too, so it stops instead of trying to fix the task.
    const toDeveloper = (await unread("developer", buildId)).map((m: Json) => [m.from, m.type, m.body]);
    expect(toDeveloper.at(-1)).toEqual(["relay", "status", "T1 escalated to James after round 3; wait for the decision."]);

    // Nobody but the human moves it while the escalation is pending.
    const review = { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW, body: "x" };
    const refused = await expectError("developer", "send", review, "conflict");
    expect(refused).toBe("T1 is escalated to James as G2; wait for the decision");
    await expectError("orchestrator", "send", review, "conflict");
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "dev", type: "task", task_id: taskId, body: "x" }, "conflict");
    const { builds } = await call("human", "build_list");
    expect(builds[0].pending_gates).toEqual([expect.objectContaining({ id: "G2", kind: "escalation" })]);
  });

  it("grants extra rounds when the escalation is approved", async () => {
    const { buildId, taskId } = await inProgressBuild();
    for (let round = 1; round <= 3; round += 1) {
      await requestReview(buildId, taskId);
      await requestChanges(buildId, taskId);
    }
    await unread("developer", buildId);
    const decided = await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved", extra_rounds: 2, note: "Two more tries" });
    expect(decided.gate).toMatchObject({ status: "approved", extra_rounds: 2, note: "Two more tries" });
    expect(decided.task).toMatchObject({ status: "changes_requested", owner: "developer", escalated: false, max_rounds: 5 });

    const [toDeveloper] = await unread("developer", buildId);
    expect(toDeveloper).toMatchObject({ from: "human", type: "status", task_id: taskId });
    expect(toDeveloper.body).toContain("2 more review round");
    expect((await unread("orchestrator", buildId)).at(-1).body).toContain("Escalation G2 approved");

    // Round 4 is now allowed and a fourth "changes_requested" does not escalate.
    await requestReview(buildId, taskId);
    const fourth = await requestChanges(buildId, taskId);
    expect(fourth.task).toMatchObject({ status: "changes_requested", round: 4 });
    expect(fourth.gate).toBeUndefined();
    await requestReview(buildId, taskId);
    const fifth = await requestChanges(buildId, taskId);
    expect(fifth.task.status).toBe("blocked");
    expect(fifth.gate.id).toBe("G3");
  });

  it("defaults to one extra round", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    const decided = await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" });
    expect(decided.task.max_rounds).toBe(2);
    expect(decided.gate.extra_rounds).toBe(1);
  });

  it("cancels the task when the escalation is rejected", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    await unread("developer", buildId);
    await unread("orchestrator", buildId);
    const decided = await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "rejected", note: "Rethink it" });
    expect(decided.gate.status).toBe("rejected");
    expect(decided.task).toMatchObject({ status: "cancelled", owner: null, escalated: false, max_rounds: 1 });

    const toOrchestrator = (await unread("orchestrator", buildId)).map((m: Json) => [m.from, m.body]);
    expect(toOrchestrator).toEqual([
      ["human", 'Escalation G2 rejected: T1 "Main screen" is cancelled.\n\nNote from James: Rethink it'],
      [
        "relay",
        "T1 was cancelled; create a narrower replacement task if the work is still needed. Every task is closed: request final_signoff.",
      ],
    ]);
    expect((await unread("developer", buildId)).at(-1).body).toContain("Rethink it");
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "creative-director", type: "task", task_id: taskId, body: "x" }, "conflict");
  });

  it("lets the orchestrator only cancel or annotate a task while its escalation is pending", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    const update = (input: Record<string, unknown>) => ({ build_id: buildId, task_id: taskId, ...input });
    for (const input of [{ status: "in_progress" }, { title: "Smaller" }, { assignee: "cd" }, { status: "cancelled", title: "x" }]) {
      const message = await expectError("orchestrator", "ledger_update", update(input), "conflict");
      expect(message).toContain("escalated to James as G2");
    }
    await call("orchestrator", "ledger_update", update({ note: "James is looking", links: [{ url: "https://docs.example.com/why" }] }));
    // The assignee may add a link for James too.
    await call("developer", "ledger_update", update({ links: [{ url: "https://preview.example.com/r1-fixed" }] }));
    const { task: cancelled } = await call("orchestrator", "ledger_update", update({ status: "cancelled" }));
    expect(cancelled).toMatchObject({ status: "cancelled", escalated: false });
    expect((await ledger(buildId)).gates[1]).toMatchObject({ kind: "escalation", status: "cancelled" });
  });

  it("drops the escalation when the human moves the task out of blocked, and refuses a stale gate decision", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    const { task: unblocked } = await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect(unblocked).toMatchObject({ status: "in_progress", escalated: false, owner: "developer" });
    expect((await ledger(buildId)).gates[1].status).toBe("cancelled");

    // A gate left pending by older data is cancelled, not applied, when decided, and the flag is cleared too.
    await buildSql(buildId, "UPDATE gates SET status = 'pending' WHERE num = 2");
    await buildSql(buildId, "UPDATE tasks SET escalated = 1 WHERE num = 1");
    const message = await expectError("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" }, "conflict");
    expect(message).toBe("T1 is no longer escalated (it is in_progress), so G2 was cancelled");
    expect((await ledger(buildId)).gates[1].status).toBe("cancelled");
    expect(await task(buildId, taskId)).toMatchObject({ status: "in_progress", max_rounds: 1, escalated: false });
  });

  it("never opens a second pending escalation for one task", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    // Simulate a task that slipped back into review while its gate stayed pending.
    await buildSql(buildId, "UPDATE tasks SET status = 'in_review', owner = 'creative-director', escalated = 0 WHERE num = 1");
    const again = await call("human", "send", {
      build_id: buildId,
      to_role: "developer",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Still off"],
      body: "x",
    });
    expect(again.gate.id).toBe("G2");
    expect((await ledger(buildId)).gates.filter((gate: Json) => gate.kind === "escalation")).toHaveLength(1);
  });

  it("validates verdicts", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const verdict = { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, body: "x" };
    await expectError("creative-director", "send", { ...verdict, verdict: "approved" }, "conflict"); // not in review yet
    await expectError("developer", "send", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, body: "x" }, "invalid_input");
    await requestReview(buildId, taskId);
    await expectError("creative-director", "send", { ...verdict }, "invalid_input");
    await expectError("creative-director", "send", { ...verdict, verdict: "changes_requested" }, "invalid_input");
    await expectError("orchestrator", "send", { ...verdict, verdict: "approved" }, "forbidden");
    // The verdict goes to the assignee, who acts on it.
    const misrouted = await expectError("creative-director", "send", { ...verdict, to_role: "orchestrator", verdict: "approved" }, "invalid_input");
    expect(misrouted).toBe("send T1's verdict to its assignee (developer), who acts on it");
    await call("creative-director", "send", { ...verdict, verdict: "approved" });
    await expectError("creative-director", "send", { ...verdict, verdict: "approved" }, "conflict");
  });

  it("routes review_request to the task's reviewer, once per round", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 2 } });
    const review = { build_id: buildId, type: "review_request", task_id: taskId, links: PREVIEW, body: "x" };
    const rerouted = await expectError("developer", "send", { ...review, to_role: "orchestrator" }, "forbidden");
    expect(rerouted).toContain("T1's reviewer is creative-director");
    await expectError("orchestrator", "send", { ...review, to_role: "human" }, "forbidden");

    await requestReview(buildId, taskId);
    // A second request while in review is refused (it would burn a round), even from the orchestrator.
    for (const role of ["developer", "orchestrator", "creative-director"] as const) {
      const to_role = role === "creative-director" ? "developer" : "creative-director";
      const message = await expectError(role, "send", { ...review, to_role }, "conflict");
      expect(message).toBe("T1 is already in review with creative-director (round 1); wait for the verdict");
    }
    expect((await task(buildId, taskId)).round).toBe(1);
    await requestChanges(buildId, taskId);
    await requestReview(buildId, taskId);
    expect((await task(buildId, taskId)).round).toBe(2);
  });

  it("makes the first review_request's recipient the reviewer when none is set", async () => {
    const { buildId } = await inProgressBuild();
    const solo = await createTask(buildId, { title: "Docs", reviewer: null });
    const { task: inReview } = await send("developer", { build_id: buildId, to_role: "orchestrator", type: "review_request", task_id: solo, links: PREVIEW });
    expect(inReview).toMatchObject({ reviewer: "orchestrator", owner: "orchestrator", status: "in_review", round: 1 });
  });

  it("lets the human give a verdict", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await requestReview(buildId, taskId);
    const { task: done } = await send("human", { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, verdict: "approved" });
    expect(done.status).toBe("done");
    expect((await ledger(buildId)).verdicts[0].reviewer).toBe("human");
  });

  it("hands off with artifacts and keeps reviews with their reviewer", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("orchestrator", { build_id: buildId, to_role: "creative-director", type: "task", task_id: taskId });
    const spec = [{ url: "https://figma.example.com/spec", label: "Spec" }];
    const { task: handed } = await send("creative-director", { build_id: buildId, to_role: "developer", type: "handoff", task_id: taskId, links: spec });
    expect(handed).toMatchObject({ assignee: "developer", owner: "developer", status: "todo", artifacts: spec });
    await requestReview(buildId, taskId);
    const message = await expectError("orchestrator", "send", { build_id: buildId, to_role: "developer", type: "handoff", task_id: taskId, body: "x" }, "conflict");
    expect(message).toContain("in review");
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "developer", type: "task", task_id: taskId, body: "x" }, "conflict");
    expect((await task(buildId, taskId)).artifacts).toEqual([...spec, ...PREVIEW]);
  });
});

describe("handoff with next_task_id", () => {
  const spec = [{ url: "https://figma.example.com/spec", label: "Spec" }];

  async function designThenBuild() {
    const { buildId, taskId: build } = await inProgressBuild();
    const design = await createTask(buildId, { title: "Design", assignee: "creative-director", reviewer: null });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: build, depends_on: [design] });
    return { buildId, design, build };
  }

  it("closes the sender's finished task and gives the recipient the next one", async () => {
    const { buildId, design, build } = await designThenBuild();
    expect(await task(buildId, build)).toMatchObject({ ready: false, waiting_on: [design] });
    await readInbox("orchestrator", buildId);

    const handoff = await send("creative-director", {
      build_id: buildId,
      to_role: "developer",
      type: "handoff",
      task_id: design,
      next_task_id: build,
      links: spec,
      body: "Spec is ready; build it.",
    });
    expect(handoff.message).toMatchObject({ type: "handoff", task_id: design, next_task_id: build, to: "developer" });
    expect(handoff.task).toMatchObject({ id: design, status: "done", owner: null, assignee: "creative-director", artifacts: spec });
    expect(handoff.next_task).toMatchObject({
      id: build,
      assignee: "developer",
      owner: "developer",
      status: "todo",
      ready: true,
      waiting_on: [],
      artifacts: spec,
    });
    const [notice] = await readInbox("orchestrator", buildId);
    expect(notice).toMatchObject({ from: "relay", task_id: design });
    // The notice names what the close made ready, with its owner and status.
    expect(notice.body).toBe(
      'T2 "Design" is done (handed off by creative-director; developer continues on T1). Now ready: T1 "Main screen" (developer, todo).',
    );
    const [received] = await readInbox("developer", buildId);
    expect(received).toMatchObject({ type: "handoff", task_id: design, next_task_id: build });
  });

  it("needs an approved task once it has a reviewer, and lets its assignee hand off after approval", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const next = await createTask(buildId, { title: "Ship", assignee: "creative-director", reviewer: null });
    const finish = { build_id: buildId, to_role: "creative-director", type: "handoff", task_id: taskId, next_task_id: next, body: "x" };
    const early = await expectError("developer", "send", finish, "conflict");
    expect(early).toContain("has a reviewer (creative-director)");

    await requestReview(buildId, taskId);
    await send("creative-director", { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, verdict: "approved" });
    const { task: finished, next_task } = await send("developer", finish);
    expect(finished).toMatchObject({ status: "done", owner: null });
    expect(next_task).toMatchObject({ owner: "creative-director", status: "todo" });
  });

  it("validates both tasks and who may send it", async () => {
    const { buildId, design, build } = await designThenBuild();
    const finish = { build_id: buildId, to_role: "developer", type: "handoff", task_id: design, next_task_id: build, body: "x" };
    await expectError("developer", "send", { ...finish, to_role: "cd" }, "forbidden"); // not the design's owner
    await expectError("creative-director", "send", { ...finish, next_task_id: design }, "invalid_input");
    await expectError("creative-director", "send", { ...finish, next_task_id: "T9" }, "not_found");
    await expectError("creative-director", "send", { ...finish, type: "status" }, "invalid_input");
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: build, status: "cancelled" });
    await expectError("creative-director", "send", finish, "conflict");
    // Without next_task_id a handoff still transfers the same task.
    const { task: same } = await send("creative-director", { ...finish, next_task_id: undefined });
    expect(same).toMatchObject({ id: design, owner: "developer", assignee: "developer", status: "todo" });
  });
});

describe("handoff with next_task_id: who may name which task", () => {
  const finish = (buildId: string, taskId: string, nextId: string, to: string) => ({
    build_id: buildId,
    to_role: to,
    type: "handoff",
    task_id: taskId,
    next_task_id: nextId,
    body: "Done; over to you.",
  });

  /** T1 (developer, reviewed), T2 the developer's own small task, T3 the CD's task in progress, T4 a CD todo task. */
  async function setup() {
    const { buildId, taskId } = await inProgressBuild();
    const mine = await createTask(buildId, { title: "Favicon", reviewer: null });
    const busy = await createTask(buildId, { title: "Mockups", assignee: "creative-director", reviewer: null });
    await call("creative-director", "ledger_update", { build_id: buildId, task_id: busy, status: "in_progress" });
    const queued = await createTask(buildId, { title: "Icons", assignee: "creative-director", reviewer: null });
    return { buildId, reviewed: taskId, mine, busy, queued };
  }

  it("lets an agent name only a todo task that depends on its finished one or is already the recipient's", async () => {
    const { buildId, mine, busy, queued } = await setup();
    // Another role's task that is under way can't be taken over this way…
    const underWay = await expectError("developer", "send", finish(buildId, mine, busy, "orchestrator"), "conflict");
    expect(underWay).toBe("T3 is in_progress, not todo: only the orchestrator or James move a task already under way");
    // …nor can a todo task be moved to a role the plan didn't give it to.
    const moved = await expectError("developer", "send", finish(buildId, mine, queued, "orchestrator"), "forbidden");
    expect(moved).toBe("T4 neither depends on T2 nor is assigned to orchestrator; only the orchestrator or James reassign it");
    expect(await task(buildId, busy)).toMatchObject({ owner: "creative-director", status: "in_progress" });

    // Already the recipient's: fine.
    const { task: finished, next_task } = await send("developer", finish(buildId, mine, queued, "creative-director"));
    expect(finished).toMatchObject({ id: mine, status: "done" });
    expect(next_task).toMatchObject({ id: queued, owner: "creative-director", status: "todo" });

    // A done task's assignee says what comes next only once.
    const ship = await createTask(buildId, { title: "Ship", assignee: "creative-director", reviewer: null });
    const again = await expectError("developer", "send", finish(buildId, mine, ship, "creative-director"), "conflict");
    expect(again).toMatch(/^T2's finishing handoff was already sent \(M\d+\); ask the orchestrator for what comes next$/);
  });

  it("lets an agent hand on a task that depends on its finished one, to whichever role continues it", async () => {
    const { buildId, mine } = await setup();
    const docs = await createTask(buildId, { title: "Docs", assignee: "creative-director", reviewer: null, depends_on: [mine] });
    const { next_task } = await send("developer", finish(buildId, mine, docs, "orchestrator"));
    expect(next_task).toMatchObject({ id: docs, assignee: "orchestrator", owner: "orchestrator", status: "todo", ready: true });
  });

  it("lets the orchestrator name any open task that is not in review or escalated", async () => {
    const { buildId, reviewed, mine, busy } = await setup();
    const { next_task } = await send("orchestrator", finish(buildId, mine, busy, "developer"));
    expect(next_task).toMatchObject({ id: busy, assignee: "developer", owner: "developer", status: "todo" });
    const plan = await createTask(buildId, { title: "Plan", assignee: "orchestrator", reviewer: null });
    await send("developer", { build_id: buildId, to_role: "creative-director", type: "review_request", task_id: reviewed, links: PREVIEW });
    const inReview = await expectError("orchestrator", "send", finish(buildId, plan, reviewed, "developer"), "conflict");
    expect(inReview).toBe("T1 is in review; its reviewer must send a verdict first");
  });

  it("releases the escalation when the human names an escalated task", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    const extra = await createTask(buildId, { title: "Copy", assignee: "human", reviewer: null });
    await expectError("orchestrator", "send", finish(buildId, extra, taskId, "developer"), "conflict");

    const { next_task } = await send("human", finish(buildId, extra, taskId, "developer"));
    expect(next_task).toMatchObject({ id: taskId, status: "todo", owner: "developer", escalated: false });
    const gate = (await ledger(buildId)).gates.find((g: Json) => g.kind === "escalation");
    expect(gate).toMatchObject({ id: "G2", status: "cancelled" });
    const audit = (await ledger(buildId)).audit.map((row: Json) => [row.actor, row.action, row.target]);
    expect(audit).toContainEqual(["human", "gate.cancelled", "G2"]);
  });
});

describe("round budget", () => {
  it("counts rounds by verdicts: a round that ended without one is reused", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 2 } });
    await requestReview(buildId, taskId);
    // The orchestrator can't knock a task out of review: it may only cancel it.
    const message = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "conflict");
    expect(message).toBe("T1 is in review with creative-director: its verdict moves it on (you may only cancel it)");
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "todo" });

    const again = await requestReview(buildId, taskId);
    expect(again.task).toMatchObject({ status: "in_review", round: 1 });
    // The first verdict is round 1's, so it doesn't escalate.
    const changes = await requestChanges(buildId, taskId);
    expect(changes.task).toMatchObject({ status: "changes_requested", round: 1, escalated: false });
    expect(changes.gate).toBeUndefined();
    // The human can still take a task out of review; that round is reused as well.
    await requestReview(buildId, taskId);
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect((await requestReview(buildId, taskId)).task.round).toBe(2);
    expect((await ledger(buildId)).verdicts.map((v: Json) => v.round)).toEqual([1]);
  });

  it("escalates a review_request past the budget instead of refusing it", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId, ["Fix the header"]);
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId, ["Fix the footer", "Fix\nthe spacing"]);
    // James lowers the cap; the task keeps the round it is in.
    const { build } = await call("human", "build_control", { build_id: buildId, action: "set_caps", caps: { max_review_rounds: 1 } });
    expect(build.caps.max_review_rounds).toBe(1);
    expect(await task(buildId, taskId)).toMatchObject({ status: "changes_requested", round: 2, max_rounds: 2 });
    for (const role of ["human", "orchestrator", "developer", "creative-director"] as const) await unread(role, buildId);

    const over = await requestReview(buildId, taskId);
    expect(over.message).toMatchObject({ type: "review_request", to: "creative-director" });
    expect(over.task).toMatchObject({ status: "blocked", escalated: true, owner: "human", round: 2, max_rounds: 2 });
    expect(over.task.artifacts).toEqual(PREVIEW);
    const changes = "Latest changes requested by creative-director:\n1. Fix the footer\n2. Fix the spacing";
    expect(over.gate).toMatchObject({ id: "G2", kind: "escalation", status: "pending", task_id: taskId, requested_by: "relay" });
    expect(over.gate.summary).toBe(`T1 "Main screen" has used all 2 review rounds (its round budget) and asks for another review.\n\n${changes}`);

    const [question] = await unread("human", buildId);
    expect(question).toMatchObject({ from: "relay", type: "question", task_id: taskId, on_behalf_of: "orchestrator" });
    expect(question.body).toBe(
      'Escalation G2: T1 "Main screen" has used all 2 review rounds and developer asks for another review. ' +
        "Approve G2 to grant more rounds, or reject it to cancel the task (the orchestrator can then plan a narrower one).\n\n" +
        changes,
    );
    expect((await unread("orchestrator", buildId)).map((m: Json) => [m.from, m.body])).toEqual([
      ["relay", 'T1 "Main screen" has used all 2 review rounds, so developer\'s review_request was escalated to James as G2.'],
    ]);
    expect((await unread("developer", buildId)).map((m: Json) => m.body)).toEqual(["T1 escalated to James after round 2; wait for the decision."]);
    // The reviewer got the request, plus a notice not to answer it, and can't act on it while James decides.
    expect((await unread("creative-director", buildId)).map((m: Json) => [m.from, m.type, m.body.startsWith("T1 has used") ? m.body : "…"])).toEqual([
      ["developer", "review_request", "…"],
      ["relay", "status", "T1 has used all 2 review rounds, so its latest review_request went to James as G2. Send no verdict on it; wait for the decision."],
    ]);
    await expectError("creative-director", "send", { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, verdict: "approved", body: "x" }, "conflict");

    // Approved: the next review_request starts round 3.
    await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" });
    expect((await requestReview(buildId, taskId)).task).toMatchObject({ status: "in_review", round: 3, max_rounds: 3 });
  });

  it("escalates again instead of dead-ending a task reopened after a rejected escalation", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "rejected" });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "todo" });
    const again = await requestReview(buildId, taskId);
    expect(again.task).toMatchObject({ status: "blocked", escalated: true, owner: "human", round: 1 });
    expect(again.gate).toMatchObject({ id: "G3", kind: "escalation", status: "pending" });
    expect(again.gate.summary).toContain("Latest changes requested by creative-director:\n1. Increase contrast");
  });

  it("never lowers an open task's max_rounds below its round", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 3 } });
    const fresh = await createTask(buildId, { title: "Docs" });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    await requestReview(buildId, taskId);
    await call("human", "build_control", { build_id: buildId, action: "set_caps", caps: { max_review_rounds: 1 } });
    expect(await task(buildId, taskId)).toMatchObject({ round: 2, max_rounds: 2, status: "in_review" });
    expect(await task(buildId, fresh)).toMatchObject({ round: 0, max_rounds: 1 });
    // Round 2 is in review, so its verdict is the last one: changes now escalate.
    const last = await requestChanges(buildId, taskId);
    expect(last.gate).toMatchObject({ kind: "escalation", status: "pending" });
  });
});
