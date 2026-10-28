import { describe, expect, it } from "vitest";
import { call, createBuild, createTask, expectError, inProgressBuild, ledger, send, useCleanState, type Json } from "./helpers";

useCleanState();

async function sendStatuses(buildId: string, count: number) {
  for (let i = 1; i <= count; i += 1) {
    await send("human", { build_id: buildId, to_role: "developer", type: "status", body: `update ${i}` });
  }
}

const bodies = (messages: Json[]) => messages.map((message) => message.body);

describe("inbox", () => {
  it("returns unread messages to the caller and marks them read", async () => {
    const build = await createBuild();
    await sendStatuses(build.build_id, 2);
    await send("human", { build_id: build.build_id, to_role: "creative-director", type: "status", body: "not for dev" });

    const first = await call("developer", "inbox", { build_id: build.build_id });
    expect(first.role).toBe("developer");
    expect(first.halted).toEqual({ global: false, reason: null, at: null });
    const [entry] = first.builds;
    expect(entry).toMatchObject({
      build_id: build.build_id,
      title: "Tip calculator",
      status: "planning",
      thread_key: `${build.build_id}/developer`,
      unread_remaining: 0,
      cursor: 3,
    });
    expect(bodies(entry.messages)).toEqual(["update 1", "update 2"]);
    expect(entry.messages.every((message: Json) => message.read_at !== null)).toBe(true);

    const second = await call("developer", "inbox", { build_id: build.build_id });
    expect(second.builds[0].messages).toEqual([]);
    expect(second.builds[0].cursor).toBe(4);
  });

  it("peeks without marking read", async () => {
    const build = await createBuild();
    await sendStatuses(build.build_id, 3);
    const peek = await call("developer", "inbox", { build_id: build.build_id, peek: true, limit: 2 });
    expect(bodies(peek.builds[0].messages)).toEqual(["update 1", "update 2"]);
    expect(peek.builds[0].messages[0].read_at).toBeNull();
    expect(peek.builds[0].unread_remaining).toBe(1);

    const page = await call("developer", "inbox", { build_id: build.build_id, limit: 2 });
    expect(bodies(page.builds[0].messages)).toEqual(["update 1", "update 2"]);
    expect(page.builds[0].unread_remaining).toBe(1);
    const rest = await call("developer", "inbox", { build_id: build.build_id });
    expect(bodies(rest.builds[0].messages)).toEqual(["update 3"]);
  });

  it("returns messages after `since`, read or not", async () => {
    const build = await createBuild();
    await sendStatuses(build.build_id, 3);
    await call("developer", "inbox", { build_id: build.build_id });
    const since = await call("developer", "inbox", { build_id: build.build_id, since: 2 });
    expect(since.builds[0].messages.map((message: Json) => message.seq)).toEqual([3, 4]);
    expect(since.builds[0].cursor).toBe(4);
    const none = await call("developer", "inbox", { build_id: build.build_id, since: 4 });
    expect(none.builds[0]).toMatchObject({ messages: [], cursor: 4 });
  });

  it("lists my open tasks and the pending gates", async () => {
    const build = await createBuild();
    const taskId = await createTask(build.build_id);
    await createTask(build.build_id, { title: "Design", assignee: "creative-director", reviewer: null });
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    const inbox = await call("developer", "inbox", { build_id: build.build_id });
    expect(inbox.builds[0].my_tasks.map((task: Json) => task.id)).toEqual([taskId]);
    expect(inbox.builds[0].pending_gates).toEqual([expect.objectContaining({ id: "G1", kind: "plan_approval" })]);
  });

  it("records presence with session_ref", async () => {
    const build = await createBuild();
    await call("developer", "inbox", { build_id: build.build_id, session_ref: "project-thread-42" });
    await call("developer", "inbox", { build_id: build.build_id, peek: true });
    const { threads } = await ledger(build.build_id);
    const thread = threads.find((row: Json) => row.role === "developer");
    expect(thread).toMatchObject({ thread_key: `${build.build_id}/developer`, session_ref: "project-thread-42", last_message_at: null });
    expect(thread.last_polled_at).not.toBeNull();
  });

  it("writes nothing on a bare peek", async () => {
    const build = await createBuild();
    await call("creative-director", "inbox", { build_id: build.build_id, peek: true });
    const { threads } = await ledger(build.build_id);
    expect(threads.map((row: Json) => row.role)).toEqual(["orchestrator"]);
    await call("creative-director", "inbox", { build_id: build.build_id, peek: true, session_ref: "cd-mod" });
    expect((await ledger(build.build_id)).threads.map((row: Json) => row.session_ref)).toEqual([null, "cd-mod"]);
  });

  it("reads every active build when build_id is omitted", async () => {
    const old = await createBuild({ title: "Old" });
    await call("human", "build_control", { build_id: old.build_id, action: "cancel" });
    const current = await createBuild({ title: "Current" });
    const inbox = await call("orchestrator", "inbox", { since: 99 });
    expect(inbox.builds.map((entry: Json) => entry.build_id)).toEqual([current.build_id]);
    expect(bodies(inbox.builds[0].messages)).toEqual(["Build a tip calculator web app."]);

    // A closed build can still be read by id.
    const closed = await call("orchestrator", "inbox", { build_id: old.build_id });
    expect(closed.builds[0].status).toBe("cancelled");
  });

  it("answers not_found for an unknown build", async () => {
    await expectError("developer", "inbox", { build_id: "b-aaaaaaaaaa" }, "not_found");
    await expectError("developer", "inbox", { limit: 101 }, "invalid_input");
  });

  it("works in every build status", async () => {
    const { buildId } = await inProgressBuild();
    await call("human", "build_control", { build_id: buildId, action: "halt" });
    const inbox = await call("developer", "inbox", {});
    expect(inbox.builds[0].status).toBe("halted");
  });
});
