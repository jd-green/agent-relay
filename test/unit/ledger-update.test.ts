import { describe, expect, it } from "vitest";
import { PREVIEW, call, createBuild, createTask, expectError, inProgressBuild, send, task, useCleanState } from "./helpers";

useCleanState();

describe("ledger_update: creating tasks", () => {
  it("lets the orchestrator and the human create tasks", async () => {
    const build = await createBuild();
    const { task: created } = await call("orchestrator", "ledger_update", {
      build_id: build.build_id,
      title: "Design system",
      description: "Colours and type",
      assignee: "cd",
      reviewer: "orchestrator",
      links: [{ url: "https://docs.example.com/brief" }],
      note: "Start here",
    });
    expect(created).toMatchObject({
      id: "T1",
      title: "Design system",
      description: "Colours and type",
      assignee: "creative-director",
      owner: "creative-director",
      reviewer: "orchestrator",
      status: "todo",
      round: 0,
      max_rounds: 3,
      artifacts: [{ url: "https://docs.example.com/brief" }],
      depends_on: [],
      nudge_count: 0,
      last_nudge_at: null,
      stalled: false,
      escalated: false,
    });
    expect(created.notes).toEqual([{ at: expect.any(String), by: "orchestrator", text: "Start here" }]);

    const { task: second } = await call("human", "ledger_update", {
      build_id: build.build_id,
      title: "Build it",
      assignee: "developer",
      depends_on: ["T1"],
      status: "blocked",
    });
    expect(second).toMatchObject({ id: "T2", depends_on: ["T1"], status: "blocked" });
  });

  it("refuses other roles, missing fields and the wrong build status", async () => {
    const build = await createBuild();
    const input = { build_id: build.build_id, title: "x", assignee: "developer" };
    await expectError("developer", "ledger_update", input, "forbidden");
    await expectError("creative-director", "ledger_update", input, "forbidden");
    await expectError("orchestrator", "ledger_update", { build_id: build.build_id, title: "x" }, "invalid_input");
    await expectError("orchestrator", "ledger_update", { ...input, assignee: "qa" }, "invalid_input");
    await expectError("orchestrator", "ledger_update", { ...input, status: "done" }, "invalid_input");
    await expectError("orchestrator", "ledger_update", { ...input, depends_on: ["T7"] }, "not_found");
    await call("orchestrator", "ledger_update", input);
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    await expectError("orchestrator", "ledger_update", input, "conflict");
  });
});

describe("ledger_update: permission matrix", () => {
  it("lets the orchestrator change any field but not the review statuses", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { task: updated } = await call("orchestrator", "ledger_update", {
      build_id: buildId,
      task_id: taskId,
      title: "Main screen v2",
      description: "Updated",
      assignee: "creative-director",
      reviewer: "developer",
      status: "in_progress",
    });
    expect(updated).toMatchObject({
      title: "Main screen v2",
      assignee: "creative-director",
      owner: "creative-director",
      reviewer: "developer",
      status: "in_progress",
    });
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_review" }, "forbidden");
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "changes_requested" }, "forbidden");
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, depends_on: [taskId] }, "invalid_input");
  });

  it("lets the orchestrator mark a reviewed task done only after an approved verdict", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const message = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "conflict");
    expect(message).toContain("approved verdict");
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    expect((await task(buildId, taskId)).owner).toBe("developer"); // reopening hands it back to the assignee
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });

    const other = await createTask(buildId, { reviewer: null });
    const { task: done } = await call("orchestrator", "ledger_update", { build_id: buildId, task_id: other, status: "done" });
    expect(done).toMatchObject({ status: "done", owner: null });
  });

  it("lets the human override anything", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const { task: inReview } = await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_review" });
    expect(inReview).toMatchObject({ status: "in_review", owner: "creative-director" });
    const { task: changes } = await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "changes_requested" });
    expect(changes.owner).toBe("developer");
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" });
    const noReviewer = await createTask(buildId, { reviewer: null });
    await expectError("human", "ledger_update", { build_id: buildId, task_id: noReviewer, status: "in_review" }, "invalid_input");
  });

  it("lets the current owner change status, links and note only", async () => {
    const { buildId, taskId } = await inProgressBuild();
    for (const status of ["in_progress", "blocked", "todo"]) {
      const { task: updated } = await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, status });
      expect(updated.status).toBe(status);
    }
    const { task: annotated } = await call("developer", "ledger_update", {
      build_id: buildId,
      task_id: taskId,
      links: PREVIEW,
      note: "Preview is up",
    });
    expect(annotated.artifacts).toEqual(PREVIEW);
    expect(annotated.notes.at(-1)).toMatchObject({ by: "developer", text: "Preview is up" });

    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_review" }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "cancelled" }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, assignee: "cd" }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: null }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, title: "Mine now" }, "forbidden");

    const solo = await createTask(buildId, { reviewer: null });
    const { task: done } = await call("developer", "ledger_update", { build_id: buildId, task_id: solo, status: "done" });
    expect(done.status).toBe("done");
  });

  it("refuses anyone else", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await expectError("creative-director", "ledger_update", { build_id: buildId, task_id: taskId, note: "Looks good" }, "forbidden");
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    // In review the reviewer owns the task, so the developer is now "anyone else".
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, note: "Waiting" }, "forbidden");
    await call("creative-director", "ledger_update", { build_id: buildId, task_id: taskId, note: "Reviewing" });
  });

  it("needs something to update and an existing task", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId }, "invalid_input");
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: "T9", note: "x" }, "not_found");
  });
});
