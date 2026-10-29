import { describe, expect, it } from "vitest";
import {
  PREVIEW,
  call,
  createBuild,
  createTask,
  expectError,
  inProgressBuild,
  ledger,
  relaySql,
  send,
  useCleanState,
  type Json,
} from "./helpers";

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

  it("marks each task ready or waiting_on its open dependencies", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const design = await createTask(buildId, { title: "Design", assignee: "creative-director", reviewer: null });
    const ship = await createTask(buildId, { title: "Ship", depends_on: [taskId, design] });
    const mine = async () => (await call("developer", "inbox", { build_id: buildId })).builds[0].my_tasks;
    expect((await mine()).map((t: Json) => [t.id, t.ready, t.waiting_on])).toEqual([
      [taskId, true, []],
      [ship, false, [taskId, design]],
    ]);
    await call("creative-director", "ledger_update", { build_id: buildId, task_id: design, status: "done" });
    expect((await mine()).find((t: Json) => t.id === ship)).toMatchObject({ ready: false, waiting_on: [taskId] });
    const snapshot = await ledger(buildId);
    expect(snapshot.tasks.find((t: Json) => t.id === ship)).toMatchObject({ ready: false, waiting_on: [taskId] });
    expect(snapshot.tasks.find((t: Json) => t.id === design)).toMatchObject({ ready: true, waiting_on: [] });
  });

  it("returns slim tasks: the last 5 artifacts and the last 3 notes (ledger_get keeps everything)", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await call("human", "ledger_update", {
      build_id: buildId,
      task_id: taskId,
      links: Array.from({ length: 8 }, (_, i) => ({ url: `https://preview.example.com/${i}` })),
    });
    for (let i = 0; i < 5; i += 1) await call("human", "ledger_update", { build_id: buildId, task_id: taskId, note: `note ${i}` });
    const [mine] = (await call("developer", "inbox", { build_id: buildId })).builds[0].my_tasks;
    expect(mine.artifacts.map((link: Json) => link.url.slice(-1))).toEqual(["3", "4", "5", "6", "7"]);
    expect(mine.notes.map((note: Json) => note.text)).toEqual(["note 2", "note 3", "note 4"]);
    const full = (await ledger(buildId)).tasks[0];
    expect([full.artifacts.length, full.notes.length]).toEqual([8, 5]);
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

  it("reads every active build when build_id is omitted, plus closed builds while they hold unread mail", async () => {
    const old = await createBuild({ title: "Old" });
    await call("human", "build_control", { build_id: old.build_id, action: "cancel", reason: "Wrong idea" });
    const current = await createBuild({ title: "Current" });
    // The developer has nothing in the cancelled build, so it sees only the active one.
    expect((await call("developer", "inbox", { peek: true })).builds.map((entry: Json) => entry.build_id)).toEqual([
      current.build_id,
    ]);

    const inbox = await call("orchestrator", "inbox", { since: 99 });
    expect(inbox.builds.map((entry: Json) => [entry.build_id, entry.status])).toEqual([
      [old.build_id, "cancelled"],
      [current.build_id, "planning"],
    ]);
    expect(bodies(inbox.builds[0].messages)).toEqual([
      "Build a tip calculator web app.",
      "Build cancelled by James: Wrong idea. Stop work on it.",
    ]);
    expect(bodies(inbox.builds[1].messages)).toEqual(["Build a tip calculator web app."]);

    // Delivered once: the closed build drops out after it is read.
    const again = await call("orchestrator", "inbox", {});
    expect(again.builds.map((entry: Json) => entry.build_id)).toEqual([current.build_id]);
    // A closed build can still be read by id.
    const closed = await call("orchestrator", "inbox", { build_id: old.build_id });
    expect(closed.builds[0].status).toBe("cancelled");
  });

  it("delivers the sign-off decision of a shipped build through the build-less inbox", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await send("creative-director", { build_id: buildId, to_role: "dev", type: "verdict", task_id: taskId, verdict: "approved" });
    await call("orchestrator", "inbox", {});
    await call("orchestrator", "gate_request", { build_id: buildId, kind: "final_signoff", summary: "Done" });
    await call("human", "gate_decide", { build_id: buildId, gate_id: "G2", decision: "approved", note: "Great, fix the footer later" });

    const peek = await call("orchestrator", "inbox", { peek: true });
    expect(peek.builds.map((entry: Json) => entry.status)).toEqual(["shipped"]);
    expect(peek.builds[0].messages[0].body).toContain("Great, fix the footer later");
    // A peek leaves it unread, so it is still listed; RelayDO tracks who has unread mail in closed builds.
    const unreadIn = async () => ((await relaySql("SELECT role FROM unread WHERE build_id = ?", buildId)) as Json[]).map((row) => row.role);
    expect(await unreadIn()).toEqual(["creative-director", "developer", "human", "orchestrator"]);
    expect((await call("orchestrator", "inbox", {})).builds[0].messages).toHaveLength(1);
    expect((await call("orchestrator", "inbox", {})).builds).toEqual([]);
    expect(await unreadIn()).toEqual(["creative-director", "developer", "human"]);
    // The developer still gets its unread verdict from the shipped build.
    expect((await call("developer", "inbox", {})).builds.map((entry: Json) => entry.messages.map((m: Json) => m.type))).toEqual([["verdict"]]);
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
