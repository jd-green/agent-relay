import { DurableObject } from "cloudflare:workers";
import { loadConfig, type Config } from "./config";
import { capture, fail, type Outcome } from "./errors";
import { CLOSED_BUILD_STATUSES, iso, isoOrNull, type AuditDetail, type Build, type BuildSummary, type Halted } from "./model";
import { displayName, type Role } from "./roles";
import type { SpikeEventInput, ToolInput, WakeInput } from "./schemas";
import { buildStub } from "./stubs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS builds (
  build_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rev INTEGER NOT NULL,
  summary TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kill_switch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL,
  reason TEXT,
  at_ms INTEGER NOT NULL,
  by_role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS spike_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_ms INTEGER NOT NULL,
  role TEXT NOT NULL,
  event TEXT NOT NULL,
  ts TEXT,
  session_id TEXT,
  surface TEXT,
  agent_id TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  text TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  consumed_ms INTEGER,
  consumed_by TEXT,
  role TEXT
);
CREATE TABLE IF NOT EXISTS unread (
  build_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (build_id, role)
);
`;

/** Spike events kept (newest first); older ones are trimmed on insert. */
export const SPIKE_EVENTS_KEPT = 5000;
const CLOSED_SQL = CLOSED_BUILD_STATUSES.map((status) => `'${status}'`).join(", ");
const BUILD_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

type SpikeEventRow = {
  id: number;
  received_ms: number;
  role: Role;
  event: string;
  ts: string | null;
  session_id: string | null;
  surface: string | null;
  agent_id: string | null;
  detail: string | null;
};

type WakeRow = {
  id: number;
  role: Role | null;
  session_id: string | null;
  text: string;
  created_by: Role;
  created_ms: number;
  consumed_ms: number | null;
  consumed_by: string | null;
};

export interface SpikeEvent {
  id: number;
  received_at: string;
  role: Role;
  event: string;
  ts: string | null;
  session_id: string | null;
  surface: string | null;
  agent_id: string | null;
  detail: unknown;
}

export interface Wake {
  id: string;
  /** Only a poller with this role's token receives it. */
  role: Role | null;
  session_id: string | null;
  text: string;
  created_by: Role;
  created_at: string;
  consumed_at: string | null;
  consumed_by: string | null;
}

export interface SpikeEventQuery {
  since_id?: number;
  since_ms?: number;
  limit: number;
}

function newBuildId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `b-${Array.from(bytes, (byte) => BUILD_ID_ALPHABET[byte & 31]).join("")}`;
}

function spikeEventOut(row: SpikeEventRow): SpikeEvent {
  return {
    id: row.id,
    received_at: iso(row.received_ms),
    role: row.role,
    event: row.event,
    ts: row.ts,
    session_id: row.session_id,
    surface: row.surface,
    agent_id: row.agent_id,
    detail: row.detail === null ? null : JSON.parse(row.detail),
  };
}

function wakeOut(row: WakeRow): Wake {
  return {
    id: `W${row.id}`,
    role: row.role,
    session_id: row.session_id,
    text: row.text,
    created_by: row.created_by,
    created_at: iso(row.created_ms),
    consumed_at: isoOrNull(row.consumed_ms),
    consumed_by: row.consumed_by,
  };
}

/**
 * The singleton ("global"): build registry with one summary row per build, the
 * global kill switch, global audit rows, and the spike's events and wake requests.
 */
export class RelayDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly config: Config;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.config = loadConfig(env);
    this.sql.exec(SCHEMA);
    this.migrate();
  }

  /** Brings storage written by an earlier version up to the current schema. */
  private migrate(): void {
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(wakes)").toArray();
    if (!columns.some((column) => column.name === "role")) this.sql.exec("ALTER TABLE wakes ADD COLUMN role TEXT");
  }

  // ---------------------------------------------------------------- kill switch

  getKillSwitch(): Halted {
    const row = this.sql
      .exec<{ active: number; reason: string | null; at_ms: number }>("SELECT active, reason, at_ms FROM kill_switch")
      .toArray()[0];
    return { global: row?.active === 1, reason: row?.reason ?? null, at: row ? iso(row.at_ms) : null };
  }

  async setKillSwitch(actor: Role, on: boolean, reason?: string): Promise<Halted> {
    const now = Date.now();
    const wasOn = this.getKillSwitch().global;
    const storedReason = on ? (reason ?? `kill switch turned on by ${displayName(actor, this.config)}`) : null;
    this.sql.exec(
      `INSERT INTO kill_switch (id, active, reason, at_ms, by_role) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET active = excluded.active, reason = excluded.reason,
         at_ms = excluded.at_ms, by_role = excluded.by_role`,
      on ? 1 : 0,
      storedReason,
      now,
      actor,
    );
    this.audit(actor, on ? "kill_switch.on" : "kill_switch.off", null, { reason: reason ?? null }, now);
    const halted = this.getKillSwitch();
    // Each build checks its own copy inside every agent write, so the toggle is pushed to all of them before
    // this answers: no agent write that passed the Worker's check before the toggle can land after it. A build
    // whose push fails still has the Worker's check, and its alarm re-reads the switch.
    const clearedBy = wasOn && !on ? actor : null;
    await Promise.all(
      this.activeBuildIds().map((id) =>
        buildStub(this.env, id)
          .setGlobalHalt(halted, clearedBy)
          .catch((err: unknown) => console.error(`kill switch push to ${id} failed`, err)),
      ),
    );
    return halted;
  }

  // ---------------------------------------------------------------- builds

  async createBuild(actor: Role, input: ToolInput<"build_create">): Promise<Outcome<Build>> {
    // Reserve the registry row synchronously so concurrent creates see it in the active count.
    const reserved = capture(() =>
      this.ctx.storage.transactionSync(() => {
        if (actor !== "human") this.checkAgentBuild(input);
        const active = this.activeBuildIds();
        if (active.length >= this.config.maxActiveBuilds) {
          const plural = this.config.maxActiveBuilds === 1 ? "" : "s";
          fail(
            "conflict",
            `only ${this.config.maxActiveBuilds} active build${plural} allowed at a time; ship or cancel ${active.join(", ")} first`,
          );
        }
        let id = newBuildId();
        while (this.sql.exec("SELECT 1 FROM builds WHERE build_id = ?", id).toArray().length > 0) id = newBuildId();
        const now = Date.now();
        this.sql.exec(
          "INSERT INTO builds (build_id, status, rev, summary, created_ms, updated_ms) VALUES (?, 'planning', -1, NULL, ?, ?)",
          id,
          now,
          now,
        );
        this.audit(actor, "build.created", id, { title: input.title }, now);
        return id;
      }),
    );
    if (!reserved.ok) return reserved;
    const id = reserved.result;

    const release = () => this.sql.exec("DELETE FROM builds WHERE build_id = ?", id);
    const init = await buildStub(this.env, id)
      .init({ ...input, build_id: id, created_by: actor, halted: this.getKillSwitch() })
      .catch((err: unknown) => {
        release();
        throw err;
      });
    if (!init.ok) {
      release();
      return init;
    }
    this.putSummary(init.result.summary);
    return { ok: true, result: init.result.build };
  }

  /**
   * An agent (the orchestrator) gets a build with both gates on and caps no higher than the configured
   * defaults; only the human turns gates off or raises caps (DESIGN §10).
   */
  private checkAgentBuild(input: ToolInput<"build_create">): void {
    const human = displayName("human", this.config);
    const halted = this.getKillSwitch();
    if (halted.global) {
      fail("halted", `the global kill switch is on (${halted.reason ?? "no reason given"}); stop and wait for ${human}`);
    }
    if (input.gates?.plan_approval === false || input.gates?.final_signoff === false) {
      fail("forbidden", `only ${human} may turn gates off; leave gates out (both stay on)`);
    }
    const { max_messages: messages, max_review_rounds: rounds } = input.caps ?? {};
    if ((messages ?? 0) > this.config.maxMessagesPerBuild || (rounds ?? 0) > this.config.maxReviewRounds) {
      fail(
        "forbidden",
        `caps may only be lowered (max_messages up to ${this.config.maxMessagesPerBuild}, max_review_rounds up to ` +
          `${this.config.maxReviewRounds}); only ${human} may raise them`,
      );
    }
  }

  /**
   * Stores a build's summary unless a newer revision is already stored, and which roles still have unread
   * mail in it (BuildDO reports them once the build is closed; see inboxBuildIds).
   */
  putSummary(summary: BuildSummary, unreadBy: Role[] = []): void {
    this.sql.exec(
      "UPDATE builds SET status = ?, rev = ?, summary = ?, updated_ms = ? WHERE build_id = ? AND rev < ?",
      summary.status,
      summary.rev,
      JSON.stringify(summary),
      Date.parse(summary.updated_at),
      summary.build_id,
      summary.rev,
    );
    this.setUnread(summary.build_id, unreadBy);
  }

  setUnread(buildId: string, roles: Role[]): void {
    this.sql.exec("DELETE FROM unread WHERE build_id = ?", buildId);
    for (const role of roles) this.sql.exec("INSERT INTO unread (build_id, role) VALUES (?, ?)", buildId, role);
  }

  listBuilds(includeClosed: boolean): BuildSummary[] {
    const filter = includeClosed ? "" : `AND status NOT IN (${CLOSED_SQL})`;
    return this.sql
      .exec<{ summary: string }>(`SELECT summary FROM builds WHERE summary IS NOT NULL ${filter} ORDER BY updated_ms DESC`)
      .toArray()
      .map((row) => JSON.parse(row.summary) as BuildSummary);
  }

  /** Builds not shipped or cancelled (including halted ones and creations still in flight), oldest first. */
  activeBuildIds(): string[] {
    return this.sql
      .exec<{ build_id: string }>(`SELECT build_id FROM builds WHERE status NOT IN (${CLOSED_SQL}) ORDER BY created_ms`)
      .toArray()
      .map((row) => row.build_id);
  }

  /** What a build-less inbox reads for `role`: every active build plus closed ones where it still has unread mail. */
  inboxBuildIds(role: Role): string[] {
    return this.sql
      .exec<{ build_id: string }>(
        `SELECT build_id FROM builds
         WHERE status NOT IN (${CLOSED_SQL}) OR build_id IN (SELECT build_id FROM unread WHERE role = ?)
         ORDER BY created_ms`,
        role,
      )
      .toArray()
      .map((row) => row.build_id);
  }

  // ---------------------------------------------------------------- spike

  addSpikeEvent(role: Role, input: SpikeEventInput): SpikeEvent {
    const ts = typeof input.ts === "number" ? iso(input.ts) : (input.ts ?? null);
    const row = this.sql
      .exec<SpikeEventRow>(
        `INSERT INTO spike_events (received_ms, role, event, ts, session_id, surface, agent_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        Date.now(),
        role,
        input.event,
        ts,
        input.session_id ?? null,
        input.surface ?? null,
        input.agent_id ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      )
      .one();
    this.sql.exec(
      "DELETE FROM spike_events WHERE id <= (SELECT id FROM spike_events ORDER BY id DESC LIMIT 1 OFFSET ?)",
      SPIKE_EVENTS_KEPT,
    );
    return spikeEventOut(row);
  }

  listSpikeEvents(query: SpikeEventQuery): SpikeEvent[] {
    return this.sql
      .exec<SpikeEventRow>(
        "SELECT * FROM spike_events WHERE id > ? AND received_ms > ? ORDER BY id DESC LIMIT ?",
        query.since_id ?? 0,
        query.since_ms ?? -1,
        query.limit,
      )
      .toArray()
      .map(spikeEventOut);
  }

  createWake(actor: Role, input: WakeInput): Wake {
    const row = this.sql
      .exec<WakeRow>(
        "INSERT INTO wakes (role, session_id, text, created_by, created_ms) VALUES (?, ?, ?, ?, ?) RETURNING *",
        input.role,
        input.session_id ?? null,
        input.text,
        actor,
        Date.now(),
      )
      .one();
    return wakeOut(row);
  }

  /**
   * Returns and consumes the caller role's pending wakes: those for this session plus untargeted ones (only
   * untargeted ones without a session).
   */
  consumeWakes(sessionId: string | null, role: Role): Wake[] {
    const now = Date.now();
    const rows = this.sql
      .exec<WakeRow>(
        "SELECT * FROM wakes WHERE consumed_ms IS NULL AND role = ? AND (session_id IS NULL OR session_id = ?) ORDER BY id",
        role,
        sessionId,
      )
      .toArray();
    for (const row of rows) {
      row.consumed_ms = now;
      row.consumed_by = sessionId ?? role;
      this.sql.exec("UPDATE wakes SET consumed_ms = ?, consumed_by = ? WHERE id = ?", now, row.consumed_by, row.id);
    }
    return rows.map(wakeOut);
  }

  // ---------------------------------------------------------------- audit

  private audit(actor: Role, action: string, target: string | null, detail: AuditDetail | null, now: number): void {
    this.sql.exec(
      "INSERT INTO audit (at_ms, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
      now,
      actor,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
    );
  }
}
