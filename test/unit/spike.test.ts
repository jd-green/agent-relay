import { describe, expect, it } from "vitest";
import { SPIKE_EVENTS_KEPT } from "../../src/relay-do";
import { api, relaySql, useCleanState, type Json } from "./helpers";

useCleanState();

describe("spike events", () => {
  it("stores events from any role and lists them newest first for the human", async () => {
    const first = await api("developer", "POST", "/spike/events", {
      event: "SessionStart",
      ts: 1_790_000_000_000,
      session_id: "s-1",
      surface: "project-thread",
      agent_id: "agent-a",
      detail: { cwd: "/repo", hooks: ["UserPromptSubmit"] },
    });
    expect(first.status).toBe(200);
    expect(first.body.result.event).toMatchObject({
      id: 1,
      role: "developer",
      event: "SessionStart",
      ts: new Date(1_790_000_000_000).toISOString(),
      session_id: "s-1",
      surface: "project-thread",
      agent_id: "agent-a",
      detail: { cwd: "/repo", hooks: ["UserPromptSubmit"] },
    });
    await api("orchestrator", "POST", "/spike/events", { event: "Stop" });
    await api("creative-director", "POST", "/spike/events", { event: "UserPromptSubmit", ts: "2026-10-28T10:00:00Z" });

    const { body } = await api("human", "GET", "/spike/events");
    expect(body.result.events.map((event: Json) => event.event)).toEqual(["UserPromptSubmit", "Stop", "SessionStart"]);
    const since = await api("human", "GET", "/spike/events?since=1&limit=1");
    expect(since.body.result.events.map((event: Json) => event.id)).toEqual([3]);
    const byTime = await api("human", "GET", `/spike/events?since=${encodeURIComponent("2000-01-01T00:00:00Z")}`);
    expect(byTime.body.result.events).toHaveLength(3);
  });

  it("validates events and restricts reading to the human", async () => {
    expect((await api("developer", "GET", "/spike/events")).status).toBe(403);
    expect((await api(null, "POST", "/spike/events", { event: "x" })).status).toBe(401);
    expect((await api("developer", "POST", "/spike/events", {})).status).toBe(400);
    const big = await api("developer", "POST", "/spike/events", { event: "x", detail: { blob: "x".repeat(5000) } });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain("4096");
    expect((await api("developer", "POST", "/spike/events", { event: "x", ts: 1e20 })).status).toBe(400);
    expect((await api("human", "GET", "/spike/events?limit=0")).status).toBe(400);
    expect((await api("human", "GET", "/spike/events?since=yesterday")).status).toBe(400);
  });

  it(`keeps only the newest ${SPIKE_EVENTS_KEPT}`, async () => {
    await api("developer", "POST", "/spike/events", { event: "warmup" });
    await relaySql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO spike_events (received_ms, role, event) SELECT 0, 'developer', 'old' FROM n`,
      SPIKE_EVENTS_KEPT,
    );
    const latest = await api("developer", "POST", "/spike/events", { event: "latest" });
    const [{ count, oldest }] = (await relaySql("SELECT COUNT(*) AS count, MIN(id) AS oldest FROM spike_events")) as Json[];
    expect(count).toBe(SPIKE_EVENTS_KEPT);
    expect(oldest).toBe(latest.body.result.event.id - SPIKE_EVENTS_KEPT + 1);
    const remaining = await relaySql("SELECT event FROM spike_events WHERE event = 'warmup'");
    expect(remaining).toEqual([]);
  });
});

describe("spike wake requests", () => {
  it("are created by the human for one role and consumed once by the matching session of that role", async () => {
    const targeted = await api("human", "POST", "/spike/wake", { role: "developer", session_id: "s-1", text: "Check your inbox" });
    expect(targeted.body.result.wake).toMatchObject({ id: "W1", role: "developer", session_id: "s-1", text: "Check your inbox", consumed_at: null });
    await api("human", "POST", "/spike/wake", { role: "developer", text: "Anyone awake?" });
    await api("human", "POST", "/spike/wake", { role: "developer", session_id: "s-2", text: "Only s-2" });
    await api("human", "POST", "/spike/wake", { role: "creative-director", session_id: "s-1", text: "For the CD" });

    // Another role polling with the same session id gets only its own wakes.
    const otherRole = await api("orchestrator", "GET", "/spike/wake?session_id=s-1");
    expect(otherRole.body.result.wakes).toEqual([]);

    const s1 = await api("developer", "GET", "/spike/wake?session_id=s-1");
    expect(s1.body.result.wakes.map((wake: Json) => wake.id)).toEqual(["W1", "W2"]);
    expect(s1.body.result.wakes[0]).toMatchObject({ consumed_by: "s-1" });
    expect(s1.body.result.wakes[0].consumed_at).not.toBeNull();
    expect((await api("developer", "GET", "/spike/wake?session_id=s-1")).body.result.wakes).toEqual([]);

    const anonymous = await api("developer", "GET", "/spike/wake");
    expect(anonymous.body.result.wakes).toEqual([]);
    const s2 = await api("developer", "GET", "/spike/wake?session_id=s-2");
    expect(s2.body.result.wakes.map((wake: Json) => wake.text)).toEqual(["Only s-2"]);
    const cd = await api("creative-director", "GET", "/spike/wake?session_id=s-1");
    expect(cd.body.result.wakes.map((wake: Json) => wake.text)).toEqual(["For the CD"]);
  });

  it("hands untargeted wakes to the first poller of that role, with or without a session", async () => {
    await api("human", "POST", "/spike/wake", { role: "developer", text: "Anyone?" });
    await api("human", "POST", "/spike/wake", { role: "human", text: "For James's own session" });
    expect((await api("orchestrator", "GET", "/spike/wake")).body.result.wakes).toEqual([]);
    const { body } = await api("developer", "GET", "/spike/wake");
    expect(body.result.wakes).toEqual([expect.objectContaining({ role: "developer", session_id: null, consumed_by: "developer" })]);
    const mine = await api("human", "GET", "/spike/wake?session_id=h-1");
    expect(mine.body.result.wakes).toEqual([expect.objectContaining({ role: "human", consumed_by: "h-1" })]);
  });

  it("require auth, a role, and only the human may create them", async () => {
    expect((await api("developer", "POST", "/spike/wake", { role: "developer", text: "x" })).status).toBe(403);
    expect((await api(null, "GET", "/spike/wake")).status).toBe(401);
    expect((await api("human", "POST", "/spike/wake", {})).status).toBe(400);
    expect((await api("human", "POST", "/spike/wake", { text: "no role" })).status).toBe(400);
    expect((await api("human", "POST", "/spike/wake", { role: "relay", text: "x" })).status).toBe(400);
    expect((await api("human", "DELETE", "/spike/wake")).status).toBe(405);
  });
});
