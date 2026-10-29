import { describe, expect, it } from "vitest";
import { PREVIEW, call, createBuild, createTask, expectError, inProgressBuild, send, task, useCleanState } from "./helpers";

const link = (i: number) => ({ url: `https://preview.example.com/${i}` });

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

  it("needs the approval to be for the current round, and no review in progress", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" });
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    // Round 2 is in review; round 1's approval does not count.
    const inReview = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "conflict");
    expect(inReview).toContain("in review");
    await send("creative-director", {
      build_id: buildId,
      to_role: "dev",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Fix it"],
    });
    const message = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "conflict");
    expect(message).toContain("approved verdict for its current round (2)");
  });

  it("refuses to clear the reviewer and then mark a reviewed task done", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    // The reviewer can't change while the review loop runs.
    for (const reviewer of [null, "orchestrator"]) {
      await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer }, "conflict");
    }
    await send("creative-director", {
      build_id: buildId,
      to_role: "dev",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Fix it"],
    });
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: null }, "conflict");
    // Setting the same reviewer again is not a change.
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: "creative-director", note: "Same reviewer" });

    // Moving the task out of the loop doesn't unlock the reviewer: once reviewed, only the human changes it.
    await call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "todo" });
    for (const reviewer of [null, "orchestrator"]) {
      const message = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, reviewer }, "conflict");
      expect(message).toBe("T1 has been reviewed (round 1): only James may change its reviewer");
    }
    await call("human", "ledger_update", { build_id: buildId, task_id: taskId, reviewer: null });
    // Round 1 still needs its approval.
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "conflict");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "done" }, "conflict");
    expect((await task(buildId, taskId)).status).toBe("todo");
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
    await expectError("human", "ledger_update", { build_id: buildId, task_id: "T2", note: "x" }, "not_found");
  });

  it("keeps a task in review until the verdict: the reviewer may only add notes and links", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    for (const status of ["in_progress", "todo", "blocked"]) {
      const message = await expectError("creative-director", "ledger_update", { build_id: buildId, task_id: taskId, status }, "conflict");
      expect(message).toBe("T1 is in review: answer it with a verdict");
    }
    const { task: noted } = await call("creative-director", "ledger_update", {
      build_id: buildId,
      task_id: taskId,
      note: "Reviewing on mobile",
      links: [{ url: "https://docs.example.com/review-notes" }],
    });
    expect(noted).toMatchObject({ status: "in_review", owner: "creative-director" });
    await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });
  });

  it("lets the assignee add links and a note while someone else holds the task", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    const working = { url: "https://preview.example.com/working-link" };
    const { task: added } = await call("developer", "ledger_update", { build_id: buildId, task_id: taskId, links: [working], note: "Use this link" });
    expect(added).toMatchObject({ status: "in_review", owner: "creative-director", artifacts: [...PREVIEW, working] });
    expect(added.notes.at(-1)).toMatchObject({ by: "developer", text: "Use this link" });
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, status: "in_progress" }, "forbidden");
    await expectError("developer", "ledger_update", { build_id: buildId, task_id: taskId, title: "x", note: "y" }, "forbidden");
  });

  it("keeps at most 50 distinct artifacts and 50 notes per task, each note at most 2,000 chars", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const update = (input: Record<string, unknown>) => call("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, ...input });
    // Duplicate URLs are dropped, within one call and across calls.
    const { task: deduped } = await update({ links: [link(0), link(0), link(1)] });
    expect(deduped.artifacts).toEqual([link(0), link(1)]);
    await update({ links: [link(1), link(2)] });
    expect((await task(buildId, taskId)).artifacts).toHaveLength(3);
    for (let start = 3; start < 50; start += 20) {
      await update({ links: Array.from({ length: Math.min(20, 50 - start) }, (_, i) => link(start + i)) });
    }
    expect((await task(buildId, taskId)).artifacts).toHaveLength(50);
    await update({ links: [link(7)] }); // nothing new
    const full = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, links: [link(99)] }, "invalid_input");
    expect(full).toContain("at most 50");

    // The human (no write burst limit) fills the notes.
    for (let i = 0; i < 50; i += 1) await call("human", "ledger_update", { build_id: buildId, task_id: taskId, note: `note ${i}` });
    const notes = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, note: "one more" }, "invalid_input");
    expect(notes).toContain("50 notes");
    await expectError("human", "ledger_update", { build_id: buildId, task_id: taskId, note: "x".repeat(2001) }, "invalid_input");
  });

  it("keeps the newest 50 artifacts when messages add more", async () => {
    const { buildId, taskId } = await inProgressBuild();
    for (let start = 0; start < 50; start += 20) {
      await call("orchestrator", "ledger_update", {
        build_id: buildId,
        task_id: taskId,
        links: Array.from({ length: Math.min(20, 50 - start) }, (_, i) => link(start + i)),
      });
    }
    const { task: inReview } = await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: [link(100)] });
    expect(inReview.artifacts).toHaveLength(50);
    expect(inReview.artifacts.at(-1)).toEqual(link(100));
    expect(inReview.artifacts[0]).toEqual(link(1));
  });

  it("needs something to update and an existing task", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId }, "invalid_input");
    await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: "T9", note: "x" }, "not_found");
  });
});

describe("ledger_update: dependencies and limits", () => {
  it("refuses depends_on that would form a cycle, also through other tasks", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const second = await createTask(buildId, { title: "Ship", depends_on: [taskId] });
    const third = await createTask(buildId, { title: "Announce", depends_on: [second] });
    const direct = await expectError("orchestrator", "ledger_update", { build_id: buildId, task_id: taskId, depends_on: [second] }, "invalid_input");
    expect(direct).toBe("depends_on would create a cycle (T1 -> T2 -> T1); a task can't wait on itself");
    const around = await expectError("human", "ledger_update", { build_id: buildId, task_id: taskId, depends_on: [third] }, "invalid_input");
    expect(around).toBe("depends_on would create a cycle (T1 -> T3 -> T2 -> T1); a task can't wait on itself");
    expect((await task(buildId, taskId)).depends_on).toEqual([]);
    // Shared dependencies are fine (no cycle).
    const { task: diamond } = await call("orchestrator", "ledger_update", { build_id: buildId, task_id: third, depends_on: [second, taskId, taskId] });
    expect(diamond.depends_on).toEqual([second, taskId]);
  });

  it("holds at most 100 tasks per build", async () => {
    const build = await createBuild();
    for (let i = 1; i <= 100; i += 1) await call("human", "ledger_update", { build_id: build.build_id, title: `Task ${i}`, assignee: "developer" });
    const message = await expectError("human", "ledger_update", { build_id: build.build_id, title: "One more", assignee: "developer" }, "conflict");
    expect(message).toBe(`build ${build.build_id} already has 100 tasks, the most a build holds; update or reuse existing tasks`);
    await expectError("orchestrator", "ledger_update", { build_id: build.build_id, title: "One more", assignee: "developer" }, "conflict");
  });
});
