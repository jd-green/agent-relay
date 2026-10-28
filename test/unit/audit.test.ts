import { describe, expect, it } from "vitest";
import { PREVIEW, call, inProgressBuild, ledger, relaySql, runAlarm, buildSql, send, useCleanState, type Json } from "./helpers";

useCleanState();

describe("audit", () => {
  it("records every message, task change, gate, halt and nudge in the build", async () => {
    const { buildId, taskId } = await inProgressBuild();
    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    await call("human", "build_control", { build_id: buildId, action: "halt", reason: "Pause" });
    await call("human", "build_control", { build_id: buildId, action: "resume" });
    await buildSql(buildId, "UPDATE tasks SET last_activity_ms = last_activity_ms - 3600000");
    await runAlarm(buildId);

    const { audit, messages } = await ledger(buildId);
    const nudge = messages.find((message: Json) => message.body.startsWith("Nudge:"));
    const rows = audit.map((row: Json) => [row.actor, row.action, row.target]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["human", "build.created", buildId],
        ["human", "message.sent", "M1"],
        ["orchestrator", "task.created", taskId],
        ["orchestrator", "gate.requested", "G1"],
        ["relay", "gate.decided", "G1"],
        ["relay", "build.status", buildId],
        ["relay", "message.sent", "M2"], // the plan auto-approval notice
        ["developer", "message.sent", "M3"],
        ["developer", "task.updated", taskId],
        ["human", "build.halted", buildId],
        ["human", "build.resumed", buildId],
        ["relay", "nudge.sent", taskId],
        ["relay", "message.sent", nudge.id],
      ]),
    );
    for (const row of audit) {
      expect(row.seq).toBeGreaterThan(0);
      expect(row.at).toMatch(/Z$/);
    }
    const update = audit.find((row: Json) => row.action === "task.updated");
    expect(update.detail).toMatchObject({ status: "in_review", owner: "creative-director", round: 1, artifacts: 1 });
    expect(audit.find((row: Json) => row.action === "build.halted").detail).toEqual({ from: "in_progress", reason: "Pause" });
  });

  it("keeps kill switch toggles and build creation in the global log", async () => {
    const { buildId } = await inProgressBuild();
    await call("human", "kill_switch", { on: true, reason: "Stop" });
    await call("human", "kill_switch", { on: false });
    const rows = (await relaySql("SELECT actor, action, target, detail FROM audit ORDER BY seq")) as Json[];
    expect(rows).toEqual([
      { actor: "human", action: "build.created", target: buildId, detail: JSON.stringify({ title: "Tip calculator" }) },
      { actor: "human", action: "kill_switch.on", target: null, detail: JSON.stringify({ reason: "Stop" }) },
      { actor: "human", action: "kill_switch.off", target: null, detail: JSON.stringify({ reason: null }) },
    ]);
  });
});
