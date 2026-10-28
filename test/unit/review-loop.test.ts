import { describe, expect, it } from "vitest";
import { PREVIEW, call, expectError, inProgressBuild, ledger, send, task, useCleanState, type Json } from "./helpers";

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

    // The developer can't push it back to review while it is blocked.
    await expectError("developer", "send", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW, body: "x" }, "forbidden");
    await expectError("orchestrator", "send", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW, body: "x" }, "conflict");
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

  it("hands the blocked task to the orchestrator when the escalation is rejected", async () => {
    const { buildId, taskId } = await inProgressBuild({ caps: { max_review_rounds: 1 } });
    await requestReview(buildId, taskId);
    await requestChanges(buildId, taskId);
    await unread("developer", buildId);
    const decided = await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "rejected", note: "Rethink it" });
    expect(decided.gate.status).toBe("rejected");
    expect(decided.task).toMatchObject({ status: "blocked", owner: "orchestrator", max_rounds: 1 });
    expect((await unread("orchestrator", buildId)).at(-1).body).toContain("Escalation G2 rejected");
    expect((await unread("developer", buildId)).at(-1).body).toContain("Rethink it");

    // The orchestrator can re-plan the task with a task message.
    const { task: replanned } = await send("orchestrator", { build_id: buildId, to_role: "creative-director", type: "task", task_id: taskId });
    expect(replanned).toMatchObject({ status: "todo", assignee: "creative-director", owner: "creative-director" });
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
    await call("creative-director", "send", { ...verdict, verdict: "approved" });
    await expectError("creative-director", "send", { ...verdict, verdict: "approved" }, "conflict");
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
