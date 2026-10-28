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
    expect(toDeveloper.at(-1)).toEqual(["relay", "status", "T1 escalated to James after round 3; wait for his decision."]);

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

    // A gate left pending by older data is cancelled, not applied, when decided.
    await buildSql(buildId, "UPDATE gates SET status = 'pending' WHERE num = 2");
    const message = await expectError("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved" }, "conflict");
    expect(message).toBe("T1 is no longer escalated (it is in_progress), so G2 was cancelled");
    expect((await ledger(buildId)).gates[1].status).toBe("cancelled");
    expect(await task(buildId, taskId)).toMatchObject({ status: "in_progress", max_rounds: 1 });
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

  it("routes review_request to the task's reviewer, once per round, within the round budget", async () => {
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
    await send("human", { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, verdict: "approved" });

    // Reopened after its last round: no review_request can start a round past max_rounds.
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    const spent = await expectError("developer", "send", { ...review, to_role: "creative-director" }, "conflict");
    expect(spent).toBe("T1 has used all 2 review rounds");
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
    expect(notice.body).toBe('T2 "Design" is done (handed off by creative-director; developer continues on T1).');
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
