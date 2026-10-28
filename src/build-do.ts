import { DurableObject } from "cloudflare:workers";
import { loadConfig, type Config } from "./config";
import { capture, fail, type Outcome } from "./errors";
import {
  CLOSED_BUILD_STATUSES,
  CLOSED_TASK_STATUSES,
  WORK_MESSAGE_TYPES,
  iso,
  isoOrNull,
  type AuditDetail,
  type AuditEntry,
  type Build,
  type BuildStatus,
  type BuildSummary,
  type Gate,
  type GateKind,
  type GateStatus,
  type Halted,
  type InboxBuild,
  type Ledger,
  type Link,
  type Message,
  type MessageType,
  type Note,
  type Task,
  type TaskStatus,
  type Thread,
  type Verdict,
  type VerdictValue,
} from "./model";
import { RELAY, displayName, isAgent, resolveRole, roleList, type Actor, type Role } from "./roles";
import type { ToolInput } from "./schemas";
import { relayStub } from "./stubs";

const SCHEMA = `
CREATE TABLE build (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  build_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  status_before_halt TEXT,
  halt_reason TEXT,
  gate_plan_approval INTEGER NOT NULL,
  gate_final_signoff INTEGER NOT NULL,
  max_messages INTEGER NOT NULL,
  max_review_rounds INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE tasks (
  num INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assignee TEXT NOT NULL,
  owner TEXT,
  reviewer TEXT,
  status TEXT NOT NULL,
  round INTEGER NOT NULL,
  max_rounds INTEGER NOT NULL,
  artifacts TEXT NOT NULL,
  notes TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  nudge_count INTEGER NOT NULL,
  last_nudge_ms INTEGER,
  stalled INTEGER NOT NULL,
  escalated INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  body TEXT NOT NULL,
  links TEXT NOT NULL,
  verdict TEXT,
  changes TEXT,
  reply_to TEXT,
  on_behalf_of TEXT,
  created_ms INTEGER NOT NULL,
  read_ms INTEGER,
  next_task_id TEXT
);
CREATE INDEX messages_inbox ON messages (to_role, read_ms, seq);
CREATE INDEX messages_sender ON messages (from_role, created_ms);
CREATE TABLE gates (
  num INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  summary TEXT NOT NULL,
  links TEXT NOT NULL,
  auto INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  requested_ms INTEGER NOT NULL,
  decided_by TEXT,
  decided_ms INTEGER,
  note TEXT,
  extra_rounds INTEGER
);
CREATE TABLE verdicts (
  num INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  changes TEXT,
  reviewer TEXT NOT NULL,
  message_seq INTEGER NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE threads (
  role TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  last_message_ms INTEGER,
  last_poll_ms INTEGER,
  session_ref TEXT
);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`;

/**
 * Tables added after the first release. init() creates them with SCHEMA; migrate() adds them to builds an
 * earlier version stored. `writes` logs agent ledger_update / gate_request calls (write burst limit, activity);
 * `local_state` holds this build's copy of the global kill switch, the summary-retry flag and the idle-build watch.
 */
const ADDED_SCHEMA = `
CREATE TABLE IF NOT EXISTS writes (
  seq INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS writes_role ON writes (role, at_ms);
CREATE TABLE IF NOT EXISTS local_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_halted INTEGER NOT NULL DEFAULT 0,
  global_halt_reason TEXT,
  summary_dirty INTEGER NOT NULL DEFAULT 0,
  idle_since_ms INTEGER,
  idle_nudge_count INTEGER NOT NULL DEFAULT 0,
  idle_last_nudge_ms INTEGER
);
INSERT OR IGNORE INTO local_state (id) VALUES (1);
`;

/** Tasks the nudger may watch (they must also be ready, and the build in_progress). */
const WATCHED_TASK = "status NOT IN ('done', 'cancelled') AND owner IS NOT NULL AND owner <> 'human' AND nudge_count < 2";
const OPEN_TASK = "status NOT IN ('done', 'cancelled')";
const LEDGER_TAIL = 50;
const EXCERPT_LENGTH = 140;
/** Per-task bounds (DESIGN §10, ledger_update). */
const MAX_ARTIFACTS = 50;
const MAX_NOTES = 50;
/** inbox my_tasks carries only the newest artifacts and notes; ledger_get has the full rows. */
const SLIM_ARTIFACTS = 5;
const SLIM_NOTES = 3;
/** Agent ledger_update + gate_request calls allowed per role per build per 60 s, as a multiple of BURST_PER_MINUTE. */
const WRITE_BURST_FACTOR = 3;
const SUMMARY_RETRY_MS = 60_000;
const SIGNOFF_HINT = " Every task is closed: request final_signoff.";

type BuildRow = {
  build_id: string;
  title: string;
  brief: string;
  status: BuildStatus;
  status_before_halt: BuildStatus | null;
  halt_reason: string | null;
  gate_plan_approval: number;
  gate_final_signoff: number;
  max_messages: number;
  max_review_rounds: number;
  message_count: number;
  rev: number;
  created_by: Role;
  created_ms: number;
  updated_ms: number;
};

type TaskRow = {
  num: number;
  title: string;
  description: string;
  assignee: Role;
  owner: Role | null;
  reviewer: Role | null;
  status: TaskStatus;
  round: number;
  max_rounds: number;
  artifacts: string;
  notes: string;
  depends_on: string;
  last_activity_ms: number;
  nudge_count: number;
  last_nudge_ms: number | null;
  stalled: number;
  escalated: number;
  created_ms: number;
  updated_ms: number;
};

type MessageRow = {
  seq: number;
  from_role: Actor;
  to_role: Role;
  type: MessageType;
  task_id: string | null;
  next_task_id: string | null;
  body: string;
  links: string;
  verdict: VerdictValue | null;
  changes: string | null;
  reply_to: string | null;
  on_behalf_of: Role | null;
  created_ms: number;
  read_ms: number | null;
};

type GateRow = {
  num: number;
  kind: GateKind;
  status: GateStatus;
  task_id: string | null;
  summary: string;
  links: string;
  auto: number;
  requested_by: Actor;
  requested_ms: number;
  decided_by: Actor | null;
  decided_ms: number | null;
  note: string | null;
  extra_rounds: number | null;
};

type VerdictRow = {
  num: number;
  task_id: string;
  round: number;
  verdict: VerdictValue;
  changes: string | null;
  reviewer: Role;
  message_seq: number;
  created_ms: number;
};

type ThreadRow = {
  role: Role;
  created_ms: number;
  last_message_ms: number | null;
  last_poll_ms: number | null;
  session_ref: string | null;
};

type AuditRow = {
  seq: number;
  at_ms: number;
  actor: Actor;
  action: string;
  target: string | null;
  detail: string | null;
};

type LocalStateRow = {
  global_halted: number;
  global_halt_reason: string | null;
  summary_dirty: number;
  /** Since when the build has been in_progress with no open task and no pending gate (null: it isn't). */
  idle_since_ms: number | null;
  idle_nudge_count: number;
  idle_last_nudge_ms: number | null;
};

/** A task as it is edited in memory before being written back in one UPDATE. */
interface TaskState extends Omit<TaskRow, "artifacts" | "notes" | "depends_on" | "stalled" | "escalated"> {
  artifacts: Link[];
  notes: Note[];
  depends_on: string[];
  stalled: boolean;
  escalated: boolean;
}

interface NewMessage {
  from: Actor;
  to: Role;
  type: MessageType;
  body: string;
  task_id?: string | null;
  next_task_id?: string | null;
  links?: Link[];
  verdict?: VerdictValue | null;
  changes?: string[] | null;
  reply_to?: string | null;
  on_behalf_of?: Role | null;
}

/** One thing the nudger watches: a task (owned by `owner`), or the idle build itself (task null, owner orchestrator). */
interface NudgeItem {
  task: TaskState | null;
  owner: Role;
  /** 1: the first nudge is due next; 2: the second-miss escalation is. */
  step: 1 | 2;
  due: number;
  /** Start of the idle time the message reports. */
  idleSince: number;
}

export interface InitInput {
  build_id: string;
  title: string;
  brief: string;
  gates?: { plan_approval?: boolean; final_signoff?: boolean };
  caps?: { max_messages?: number; max_review_rounds?: number };
  created_by: Role;
  /** The global kill switch when RelayDO reserved the build. */
  halted?: Halted;
}

export interface InboxOptions {
  since?: number;
  peek: boolean;
  limit: number;
  session_ref?: string;
}

export interface SendResult {
  message: Message;
  task?: Task;
  /** handoff with next_task_id: the task the recipient continues on. */
  next_task?: Task;
  gate?: Gate;
}

export interface GateDecision {
  gate: Gate;
  build: Build;
  task?: Task;
}

type SendInput = ToolInput<"send">;
type LedgerUpdateInput = ToolInput<"ledger_update">;

const UPDATE_FIELDS = ["title", "description", "assignee", "reviewer", "depends_on", "status", "links", "note"] as const;
type UpdateField = (typeof UPDATE_FIELDS)[number];
const OWNER_FIELDS: readonly UpdateField[] = ["status", "links", "note"];
/** What the assignee may add while someone else holds the task, and all the orchestrator may add during an escalation. */
const NOTE_FIELDS: readonly UpdateField[] = ["links", "note"];
const OWNER_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "blocked"];
/** Task fields whose changes are written to the audit log. */
const AUDITED_TASK_FIELDS = [
  "title",
  "description",
  "assignee",
  "owner",
  "reviewer",
  "status",
  "round",
  "max_rounds",
  "depends_on",
  "stalled",
  "escalated",
] as const;

const GATE_LABELS: Record<GateKind, string> = {
  plan_approval: "plan approval",
  final_signoff: "final sign-off",
  escalation: "escalation",
};

const taskId = (num: number) => `T${num}`;
const idNumber = (id: string) => Number(id.slice(1));
const label = (task: TaskState) => `${taskId(task.num)} "${task.title}"`;
const isClosed = (status: TaskStatus) => CLOSED_TASK_STATUSES.includes(status);

function parseJson<T>(text: string | null, fallback: T): T {
  return text === null ? fallback : (JSON.parse(text) as T);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function numbered(items: readonly string[], maxLength = 2000): string {
  const text = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** ": <reason>." for a notice, or "." without one (no doubled full stop). */
function because(reason: string | undefined): string {
  const text = reason?.trim();
  if (!text) return ".";
  return /[.!?]$/.test(text) ? `: ${text}` : `: ${text}.`;
}

/**
 * One build: its messages, tasks, gates, verdicts, presence and audit log, plus the
 * nudge alarm. Every RPC method does its read-check-write inside one synchronous
 * transaction, then reschedules the alarm and pushes its summary to RelayDO.
 */
export class BuildDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly config: Config;
  /** Null until init() has run; only init() creates tables, so probing an unknown id stores nothing. */
  private buildId: string | null = null;
  /** A kill switch push that arrived while init() was still in flight. */
  private pendingHalt: Halted | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.config = loadConfig(env);
    const hasSchema = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'build'").toArray();
    if (hasSchema.length > 0) {
      this.migrate();
      this.buildId = this.sql.exec<{ build_id: string }>("SELECT build_id FROM build").toArray()[0]?.build_id ?? null;
    }
  }

  // ---------------------------------------------------------------- RPC methods

  init(input: InitInput): Outcome<{ build: Build; summary: BuildSummary }> {
    if (this.buildId !== null) return { ok: false, error: { code: "conflict", message: "build already exists" } };
    this.buildId = input.build_id;
    let outcome: Outcome<{ build: Build; summary: BuildSummary }> | undefined;
    try {
      outcome = this.mutate(() => this.createBuild(input));
      return outcome;
    } finally {
      if (!outcome?.ok) this.buildId = null;
    }
  }

  async send(actor: Role, input: SendInput): Promise<Outcome<SendResult>> {
    const outcome = this.mutate(() => this.applySend(actor, input));
    if (!outcome.ok && outcome.error.code === "cap_reached") {
      this.mutate(() => this.haltForCap(actor));
    } else if (!outcome.ok) {
      return outcome;
    }
    await this.afterChange();
    return outcome;
  }

  updateTask(actor: Role, input: LedgerUpdateInput): Promise<Outcome<{ task: Task }>> {
    return this.write(() => this.applyLedgerUpdate(actor, input));
  }

  requestGate(actor: Role, input: ToolInput<"gate_request">): Promise<Outcome<{ gate: Gate; build: Build }>> {
    return this.write(() => this.applyGateRequest(actor, input));
  }

  async decideGate(actor: Role, input: ToolInput<"gate_decide">): Promise<Outcome<GateDecision>> {
    const outcome = this.mutate(() => this.applyGateDecision(actor, input));
    if (!outcome.ok) return outcome;
    await this.afterChange();
    // A stale escalation gate was cancelled (and that is saved), but the decision itself is refused.
    if ("refused" in outcome.result) return { ok: false, error: { code: "conflict", message: outcome.result.refused } };
    return { ok: true, result: outcome.result };
  }

  control(actor: Role, input: ToolInput<"build_control">): Promise<Outcome<{ build: Build }>> {
    return this.write(() => this.applyControl(actor, input));
  }

  async inbox(actor: Role, options: InboxOptions): Promise<Outcome<InboxBuild>> {
    const outcome = this.mutate(() => this.readInbox(actor, options));
    // RelayDO lists a closed build in build-less inboxes only while someone still has unread mail in it.
    if (outcome.ok && !options.peek && CLOSED_BUILD_STATUSES.includes(outcome.result.status)) await this.pushUnread();
    return outcome;
  }

  snapshot(): Outcome<Ledger> {
    return capture(() => {
      const build = this.loadBuild();
      const statuses = this.taskStatuses();
      return {
        build: this.buildOut(build),
        tasks: this.loadTasks("ORDER BY num").map((task) => this.taskOut(task, statuses)),
        gates: this.sql.exec<GateRow>("SELECT * FROM gates ORDER BY num").toArray().map((row) => this.gateOut(row)),
        verdicts: this.sql
          .exec<VerdictRow>("SELECT * FROM verdicts ORDER BY num")
          .toArray()
          .map((row) => this.verdictOut(row)),
        messages: this.sql
          .exec<MessageRow>("SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq", LEDGER_TAIL)
          .toArray()
          .map((row) => this.messageOut(row)),
        threads: this.sql
          .exec<ThreadRow>("SELECT * FROM threads ORDER BY created_ms, role")
          .toArray()
          .map((row) => this.threadOut(row)),
        audit: this.sql
          .exec<AuditRow>("SELECT * FROM (SELECT * FROM audit ORDER BY seq DESC LIMIT ?) ORDER BY seq", LEDGER_TAIL)
          .toArray()
          .map(auditOut),
      };
    });
  }

  /**
   * RelayDO pushes every kill switch toggle here before it answers, so agent writes check the switch inside
   * their own transaction (DESIGN §7). Clearing it (clearedBy set) restarts the idle clocks, since time under
   * the switch is not idle time, and tells the orchestrator and every open task's owner to carry on.
   */
  async setGlobalHalt(halted: Halted, clearedBy: Role | null): Promise<void> {
    if (this.buildId === null) {
      this.pendingHalt = halted; // init() is still in flight; it stores this instead of its older copy
      return;
    }
    const notified = this.mutate(() => {
      this.storeGlobalHalt(halted);
      const build = this.loadBuild();
      if (clearedBy === null || build.status === "halted" || CLOSED_BUILD_STATUSES.includes(build.status)) return false;
      const now = Date.now();
      if (build.status === "in_progress") this.restartClocks(now);
      this.lifecycleNotice(`Relay kill switch cleared by ${displayName(clearedBy, this.config)}. Carry on from the ledger.`, now);
      this.saveBuild(build, now);
      return true;
    });
    if (notified.ok && notified.result) await this.afterChange();
  }

  override async alarm(): Promise<void> {
    if (this.buildId === null) return;
    const halted = await relayStub(this.env).getKillSwitch();
    this.mutate(() => this.storeGlobalHalt(halted)); // corrects a missed push
    if (halted.global) {
      // Nudges pause while the kill switch is on; look again later in case the "off" notice is missed.
      if (this.nextNudgeDue() !== null) await this.ctx.storage.setAlarm(Date.now() + this.config.nudgeAfterMs);
      if (this.localState().summary_dirty === 1) await this.pushSummary();
      return;
    }
    this.mutate(() => this.processNudges(Date.now()));
    await this.afterChange();
  }

  // ---------------------------------------------------------------- plumbing

  /** Runs fn in a synchronous transaction; a RelayError rolls it back and becomes a failed Outcome. */
  private mutate<T>(fn: () => T): Outcome<T> {
    return capture(() => this.ctx.storage.transactionSync(fn));
  }

  private async write<T>(fn: () => T): Promise<Outcome<T>> {
    const outcome = this.mutate(fn);
    if (outcome.ok) await this.afterChange();
    return outcome;
  }

  private async afterChange(): Promise<void> {
    await this.reschedule();
    await this.pushSummary();
  }

  /** The write already committed; if RelayDO can't take the summary now, the alarm retries it (DESIGN §4). */
  private async pushSummary(): Promise<void> {
    try {
      const build = this.loadBuild();
      await relayStub(this.env).putSummary(this.summaryOf(build), this.unreadRoles(build));
      if (this.localState().summary_dirty === 1) this.sql.exec("UPDATE local_state SET summary_dirty = 0");
    } catch (err) {
      console.error("pushing build summary to RelayDO failed; the alarm retries it", err);
      this.sql.exec("UPDATE local_state SET summary_dirty = 1");
      const retry = Date.now() + SUMMARY_RETRY_MS;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retry) await this.ctx.storage.setAlarm(retry);
    }
  }

  /** Tells RelayDO who still has unread mail in this (closed) build. */
  private async pushUnread(): Promise<void> {
    try {
      const build = this.loadBuild();
      await relayStub(this.env).setUnread(build.build_id, this.unreadRoles(build));
    } catch (err) {
      console.error("pushing unread roles to RelayDO failed", err);
    }
  }

  private async reschedule(): Promise<void> {
    let due = this.nextNudgeDue();
    if (this.localState().summary_dirty === 1) due = Math.min(due ?? Infinity, Date.now() + SUMMARY_RETRY_MS);
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }

  private nextNudgeDue(): number | null {
    const dues = this.nudgePlan(this.loadBuild()).map((item) => item.due);
    return dues.length === 0 ? null : Math.min(...dues);
  }

  /** Brings a build stored by an earlier version up to the current schema. */
  private migrate(): void {
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(messages)").toArray();
    if (!columns.some((column) => column.name === "next_task_id")) this.sql.exec("ALTER TABLE messages ADD COLUMN next_task_id TEXT");
    this.sql.exec(ADDED_SCHEMA);
  }

  private localState(): LocalStateRow {
    return this.sql.exec<LocalStateRow>("SELECT * FROM local_state").one();
  }

  private storeGlobalHalt(halted: Halted): void {
    this.sql.exec(
      "UPDATE local_state SET global_halted = ?, global_halt_reason = ?",
      halted.global ? 1 : 0,
      halted.global ? halted.reason : null,
    );
  }

  private human(): string {
    return displayName("human", this.config);
  }

  // ---------------------------------------------------------------- init

  private createBuild(input: InitInput): { build: Build; summary: BuildSummary } {
    const now = Date.now();
    this.sql.exec(SCHEMA);
    this.sql.exec(ADDED_SCHEMA);
    this.storeGlobalHalt(this.pendingHalt ?? input.halted ?? { global: false, reason: null, at: null });
    this.sql.exec(
      `INSERT INTO build (id, build_id, title, brief, status, gate_plan_approval, gate_final_signoff,
         max_messages, max_review_rounds, created_by, created_ms, updated_ms)
       VALUES (1, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?)`,
      input.build_id,
      input.title,
      input.brief,
      input.gates?.plan_approval === false ? 0 : 1,
      input.gates?.final_signoff === false ? 0 : 1,
      input.caps?.max_messages ?? this.config.maxMessagesPerBuild,
      input.caps?.max_review_rounds ?? this.config.maxReviewRounds,
      input.created_by,
      now,
      now,
    );
    this.audit(input.created_by, "build.created", input.build_id, { title: input.title }, now);
    // A build the human creates starts with the brief as a kickoff task message to the orchestrator.
    if (input.created_by === "human") {
      this.insertMessage({ from: "human", to: "orchestrator", type: "task", body: input.brief }, now);
    }
    const build = this.loadBuild();
    return { build: this.buildOut(build), summary: this.summaryOf(build) };
  }

  // ---------------------------------------------------------------- send

  private applySend(actor: Role, input: SendInput): SendResult {
    const now = Date.now();
    const build = this.loadBuild();
    this.assertNotKilled(actor);
    this.assertWritable(build, actor);
    const to = this.recipient(actor, input.to_role);
    if (isAgent(actor) && WORK_MESSAGE_TYPES.includes(input.type) && build.status !== "in_progress") {
      fail("conflict", `${input.type} messages are accepted only while the build is in_progress (it is ${build.status})`);
    }
    if (input.type !== "verdict" && (input.verdict !== undefined || input.changes !== undefined)) {
      fail("invalid_input", "verdict and changes belong on verdict messages only");
    }
    if (input.type !== "handoff" && input.next_task_id !== undefined) {
      fail("invalid_input", "next_task_id belongs on handoff messages only");
    }
    if (input.reply_to !== undefined) this.requireMessage(input.reply_to);
    if (isAgent(actor)) this.answerNudges(actor);
    const task = input.task_id === undefined ? null : this.loadTask(input.task_id);
    const links = input.links ?? [];
    this.validateSend(actor, to, input, task, links);
    if (isAgent(actor)) {
      this.checkLimits(actor, build, now);
      build.message_count += 1;
    }

    const message = this.insertMessage(
      {
        from: actor,
        to,
        type: input.type,
        body: input.body,
        task_id: input.task_id,
        next_task_id: input.next_task_id,
        links,
        verdict: input.verdict,
        changes: input.changes,
        reply_to: input.reply_to,
      },
      now,
    );
    const result: SendResult = { message };
    if (task) {
      const before = structuredClone(task);
      // A message from the task's current owner is activity on that task.
      if (task.owner === actor) this.resetNudges(task, now);
      const effects = this.applySendEffects(actor, to, input, task, message, links, now);
      this.releaseEscalation(actor, before, task, now);
      this.commitTask(actor, before, task, now);
      if (!isClosed(before.status) && isClosed(task.status)) {
        const how =
          input.type === "verdict"
            ? `approved by ${actor} in round ${task.round}`
            : `handed off by ${actor}; ${to} continues on ${input.next_task_id}`;
        this.taskClosed(actor, build, task, `${label(task)} is done (${how}).`, now);
      }
      result.task = this.taskOut(task);
      if (effects.next) result.next_task = this.taskOut(this.loadTask(taskId(effects.next.num)));
      if (effects.gate) result.gate = effects.gate;
    }
    this.saveBuild(build, now);
    return result;
  }

  private validateSend(actor: Role, to: Role, input: SendInput, task: TaskState | null, links: Link[]): void {
    const elevated = actor === "orchestrator" || actor === "human";
    const type = input.type;
    if (type === "question" || type === "status") return;
    if (type === "task" && !task) {
      if (actor !== "human") fail("invalid_input", "task messages need a task_id (create the task with ledger_update first)");
      return;
    }
    if (!task) fail("invalid_input", `${type} messages need a task_id`);
    const id = taskId(task.num);
    // While an escalation waits for the human, only the human moves the task.
    if (actor !== "human") this.assertNotEscalated(task);

    switch (type) {
      case "task":
      case "handoff":
        if (type === "task" && !elevated) fail("forbidden", "only the orchestrator or the human may send task messages");
        if (type === "handoff" && input.next_task_id !== undefined) {
          this.validateFinishingHandoff(actor, task, input.next_task_id);
          return;
        }
        if (type === "handoff" && !elevated && task.owner !== actor) {
          fail("forbidden", `only ${id}'s current owner (${task.owner ?? "nobody"}), the orchestrator or the human may hand it off`);
        }
        this.assertTaskOpen(task);
        // During review the reviewer holds the task; only a verdict (or the human) moves it on.
        if (task.status === "in_review" && actor !== "human") {
          fail("conflict", `${id} is in review; its reviewer must send a verdict first`);
        }
        return;
      case "review_request":
        if (links.length === 0) fail("invalid_input", "review_request needs at least one link (the preview URL)");
        if (task.status === "in_review" && actor !== "human") {
          fail("conflict", `${id} is already in review with ${task.reviewer} (round ${task.round}); wait for the verdict`);
        }
        if (!elevated && task.owner !== actor) {
          fail("forbidden", `only ${id}'s current owner (${task.owner ?? "nobody"}), the orchestrator or the human may request review`);
        }
        if (task.status === "blocked" || isClosed(task.status)) {
          fail("conflict", `${id} is ${task.status} and cannot go to review`);
        }
        if (actor !== "human" && task.reviewer !== null && to !== task.reviewer) {
          fail(
            "forbidden",
            `${id}'s reviewer is ${task.reviewer}; send the review_request there (only the orchestrator or ${this.human()} change reviewers, with ledger_update)`,
          );
        }
        if (task.round + 1 > task.max_rounds) fail("conflict", `${id} has used all ${task.max_rounds} review rounds`);
        return;
      case "verdict":
        if (input.verdict === undefined) fail("invalid_input", "verdict messages need verdict: approved or changes_requested");
        if (input.verdict === "changes_requested" && input.changes === undefined) {
          fail("invalid_input", "a changes_requested verdict needs a numbered changes list");
        }
        if (actor !== "human" && task.reviewer !== actor) {
          fail("forbidden", `only ${id}'s reviewer (${task.reviewer ?? "none"}) or the human may send its verdict`);
        }
        if (task.status !== "in_review") fail("conflict", `${id} is ${task.status}, not in_review`);
        if (actor !== "human" && to !== task.assignee) {
          fail("invalid_input", `send ${id}'s verdict to its assignee (${task.assignee}), who acts on it`);
        }
        return;
    }
  }

  /**
   * handoff with next_task_id: task is the sender's finished work and the recipient continues on another task.
   * A task with no reviewer and no review yet is closed by the handoff; any other must already be done (approved).
   */
  private validateFinishingHandoff(actor: Role, task: TaskState, nextId: string): void {
    const id = taskId(task.num);
    const elevated = actor === "orchestrator" || actor === "human";
    const done = task.status === "done";
    // Once a task is done it has no owner, so its assignee may still say what comes next.
    if (!elevated && task.owner !== actor && !(done && task.assignee === actor)) {
      fail(
        "forbidden",
        `only ${id}'s current owner (${task.owner ?? "nobody"}), its assignee once it is done, the orchestrator or the human may hand it off as finished`,
      );
    }
    if (task.status === "cancelled") fail("conflict", `${id} is cancelled, so it can't be handed off as finished`);
    if (!done && (task.reviewer !== null || task.round > 0)) {
      fail(
        "conflict",
        `${id} ${task.reviewer ? `has a reviewer (${task.reviewer})` : "has been reviewed"}: it is finished only with an approved verdict, so request review first`,
      );
    }
    const next = this.loadTask(nextId);
    if (next.num === task.num) fail("invalid_input", "next_task_id must name another task than task_id");
    this.assertTaskOpen(next);
    if (next.status === "in_review" && actor !== "human") {
      fail("conflict", `${nextId} is in review; its reviewer must send a verdict first`);
    }
    if (actor !== "human") this.assertNotEscalated(next);
  }

  private checkLimits(actor: Role, build: BuildRow, now: number): void {
    if (build.message_count >= build.max_messages) {
      fail(
        "cap_reached",
        `build ${build.build_id} reached its cap of ${build.max_messages} agent messages; it is now halted and ${this.human()} has been told`,
      );
    }
    const { n } = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE from_role = ? AND created_ms > ?", actor, now - 60_000)
      .one();
    if (n >= this.config.burstPerMinute) {
      fail("rate_limited", `${actor} sent ${n} messages in the last 60 s (limit ${this.config.burstPerMinute}); wait and retry`);
    }
  }

  private applySendEffects(
    actor: Role,
    to: Role,
    input: SendInput,
    task: TaskState,
    message: Message,
    links: Link[],
    now: number,
  ): { gate: Gate | null; next: TaskState | null } {
    const none = { gate: null, next: null };
    switch (input.type) {
      case "task":
        task.assignee = to;
        this.setOwner(task, to, now);
        if (task.status === "blocked") task.status = "todo";
        return none;
      case "handoff":
        if (input.next_task_id !== undefined) {
          return { gate: null, next: this.continueOn(actor, to, task, input.next_task_id, links, now) };
        }
        task.assignee = to;
        this.setOwner(task, to, now);
        task.status = "todo";
        this.addArtifacts(task, links, false);
        return none;
      case "review_request":
        task.round += 1;
        task.reviewer = to;
        this.setOwner(task, to, now);
        task.status = "in_review";
        this.addArtifacts(task, links, false);
        return none;
      case "verdict": {
        const verdict = input.verdict as VerdictValue; // presence checked by validateSend
        this.sql.exec(
          "INSERT INTO verdicts (task_id, round, verdict, changes, reviewer, message_seq, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          taskId(task.num),
          task.round,
          verdict,
          input.changes ? JSON.stringify(input.changes) : null,
          actor,
          message.seq,
          now,
        );
        if (verdict === "approved") {
          task.status = "done";
          this.setOwner(task, null, now);
          return none;
        }
        if (task.round >= task.max_rounds) return { gate: this.escalate(actor, task, input.changes ?? [], now), next: null };
        task.status = "changes_requested";
        this.setOwner(task, task.assignee, now);
        return none;
      }
      default:
        return none;
    }
  }

  /** The finishing handoff (validated): close the sender's task if needed and give `to` the next one. */
  private continueOn(actor: Role, to: Role, task: TaskState, nextId: string, links: Link[], now: number): TaskState {
    if (task.status !== "done") {
      task.status = "done";
      this.setOwner(task, null, now);
    }
    this.addArtifacts(task, links, false);
    const next = this.loadTask(nextId);
    const before = structuredClone(next);
    next.assignee = to;
    this.setOwner(next, to, now);
    next.status = "todo";
    this.resetNudges(next, now);
    this.addArtifacts(next, links, false);
    this.commitTask(actor, before, next, now);
    return next;
  }

  /** The review cap was hit: block the task, hand it to the human and open an escalation gate. */
  private escalate(reviewer: Role, task: TaskState, changes: string[], now: number): Gate {
    const id = taskId(task.num);
    task.status = "blocked";
    task.escalated = true;
    this.setOwner(task, "human", now);
    // Never two pending escalations for one task.
    const pending = this.pendingEscalation(id);
    if (pending) return this.loadGate(pending);
    const gate = this.insertGate(
      {
        kind: "escalation",
        task_id: id,
        summary: `${label(task)} reached ${task.round} review rounds without approval.`,
        links: task.artifacts.slice(-3),
        requested_by: RELAY,
      },
      now,
    );
    this.relayMessage(
      "human",
      "question",
      `Escalation ${gate.id}: ${label(task)} has had ${task.round} review rounds without approval. ` +
        `Approve ${gate.id} to grant more rounds, or reject it to cancel the task (the orchestrator can then plan a narrower one).\n\n` +
        `Latest changes requested by ${reviewer}:\n${numbered(changes)}`,
      now,
      { task_id: id, on_behalf_of: "orchestrator", links: gate.links },
    );
    this.relayMessage(
      "orchestrator",
      "status",
      `${label(task)} hit the review cap (${task.max_rounds} rounds) and was escalated to ${this.human()} as ${gate.id}.`,
      now,
      { task_id: id },
    );
    if (task.assignee !== "orchestrator" && task.assignee !== "human") {
      this.relayMessage(
        task.assignee,
        "status",
        `${id} escalated to ${this.human()} after round ${task.round}; wait for his decision.`,
        now,
        { task_id: id },
      );
    }
    this.audit(RELAY, "task.escalated", id, { gate: gate.id, round: task.round }, now);
    return gate;
  }

  private haltForCap(actor: Role): void {
    const now = Date.now();
    const build = this.loadBuild();
    if (build.status === "halted" || CLOSED_BUILD_STATUSES.includes(build.status)) return;
    this.halt(build, "message cap reached", RELAY, now);
    this.relayMessage(
      "human",
      "status",
      `Build "${build.title}" (${build.build_id}) is halted: it reached its cap of ${build.max_messages} agent messages ` +
        `(last attempt by ${actor}). Raise the cap with build_control set_caps, then resume it.`,
      now,
    );
    this.saveBuild(build, now);
  }

  // ---------------------------------------------------------------- ledger_update

  private applyLedgerUpdate(actor: Role, input: LedgerUpdateInput): { task: Task } {
    const now = Date.now();
    const build = this.loadBuild();
    this.assertNotKilled(actor);
    this.assertWritable(build, actor);
    this.recordWrite(actor, "ledger_update", now);
    if (isAgent(actor)) this.answerNudges(actor);
    if (input.task_id === undefined) return { task: this.createTask(actor, build, input, now) };

    const task = this.loadTask(input.task_id);
    const fields = UPDATE_FIELDS.filter((field) => input[field] !== undefined);
    if (fields.length === 0) {
      fail("invalid_input", `nothing to update: pass at least one of ${UPDATE_FIELDS.join(", ")}`);
    }
    this.checkLedgerPermission(actor, task, input, fields);

    const before = structuredClone(task);
    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.depends_on !== undefined) task.depends_on = this.checkDependencies(input.depends_on, task.num);
    if (input.assignee !== undefined) {
      task.assignee = this.roleArg("assignee", input.assignee);
      if (task.status !== "in_review" && !isClosed(task.status)) {
        this.setOwner(task, task.assignee, now);
      }
    }
    if (input.reviewer !== undefined) {
      task.reviewer = input.reviewer === null ? null : this.roleArg("reviewer", input.reviewer);
      if (task.status === "in_review" && task.reviewer) this.setOwner(task, task.reviewer, now);
    }
    if (input.status !== undefined) this.applyStatus(task, input.status, now);
    if (input.links) this.addArtifacts(task, input.links, true);
    if (input.note !== undefined) this.addNote(task, actor, input.note, now);
    // An update by the task's owner is activity on that task.
    if (before.owner === actor) this.resetNudges(task, now);
    this.releaseEscalation(actor, before, task, now);

    this.commitTask(actor, before, task, now);
    const id = taskId(task.num);
    if (!isClosed(before.status) && isClosed(task.status)) {
      const notice =
        task.status === "done"
          ? `${label(task)} is done (marked done by ${actor}).`
          : `${label(task)} was cancelled by ${actor}${because(input.note)}`;
      this.taskClosed(actor, build, task, notice, now);
    } else if (task.status === "blocked" && before.status !== "blocked" && before.owner === actor && actor !== "orchestrator") {
      this.relayMessage("orchestrator", "status", `${id} is blocked (${actor})${because(input.note)}`, now, { task_id: id });
    }
    this.saveBuild(build, now);
    return { task: this.taskOut(task) };
  }

  private createTask(actor: Role, build: BuildRow, input: LedgerUpdateInput, now: number): Task {
    if (actor !== "orchestrator" && actor !== "human") fail("forbidden", "only the orchestrator or the human may create tasks");
    if (build.status !== "planning" && build.status !== "in_progress") {
      fail("conflict", `tasks can be created only while the build is planning or in_progress (it is ${build.status})`);
    }
    if (input.title === undefined || input.assignee === undefined) {
      fail("invalid_input", "creating a task needs title and assignee (pass task_id to update an existing task)");
    }
    const status = input.status ?? "todo";
    if (!OWNER_STATUSES.includes(status)) fail("invalid_input", "a new task starts as todo, in_progress or blocked");
    const assignee = this.roleArg("assignee", input.assignee);
    const reviewer = input.reviewer ? this.roleArg("reviewer", input.reviewer) : null;
    const dependsOn = this.checkDependencies(input.depends_on ?? [], null);
    const notes: Note[] = input.note === undefined ? [] : [{ at: iso(now), by: actor, text: input.note }];
    const { num } = this.sql
      .exec<{ num: number }>(
        `INSERT INTO tasks (title, description, assignee, owner, reviewer, status, round, max_rounds, artifacts, notes,
           depends_on, last_activity_ms, nudge_count, last_nudge_ms, stalled, escalated, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, NULL, 0, 0, ?, ?) RETURNING num`,
        input.title,
        input.description ?? "",
        assignee,
        assignee,
        reviewer,
        status,
        build.max_review_rounds,
        JSON.stringify(uniqueLinks(input.links ?? [])),
        JSON.stringify(notes),
        JSON.stringify(dependsOn),
        now,
        now,
        now,
      )
      .one();
    const task = this.loadTask(taskId(num));
    this.commitTask(actor, null, task, now);
    this.saveBuild(build, now);
    return this.taskOut(task);
  }

  private checkLedgerPermission(actor: Role, task: TaskState, input: LedgerUpdateInput, fields: UpdateField[]): void {
    if (actor === "human") return;
    const id = taskId(task.num);
    if (actor === "orchestrator") {
      const escalation = this.pendingEscalation(id);
      const onlyCancelOrNotes =
        fields.every((field) => field === "status" || NOTE_FIELDS.includes(field)) &&
        (input.status === undefined || input.status === "cancelled");
      if (escalation && !onlyCancelOrNotes) {
        fail(
          "conflict",
          `${id} is escalated to ${this.human()} as ${escalation}: until the decision you may only cancel it or add notes and links`,
        );
      }
      if (input.status === "in_review" || input.status === "changes_requested") {
        fail("forbidden", `${input.status} is set by review_request and verdict messages, not ledger_update`);
      }
      // As the reviewer of a task in review, the orchestrator answers with a verdict like any reviewer.
      if (input.status !== undefined && task.status === "in_review" && task.owner === actor) {
        fail("conflict", `${id} is in review: answer it with a verdict`);
      }
      if (input.status === "done") this.assertMayMarkDone(task);
      if (input.reviewer !== undefined && (task.status === "in_review" || task.status === "changes_requested")) {
        const reviewer = input.reviewer === null ? null : this.roleArg("reviewer", input.reviewer);
        if (reviewer !== task.reviewer) {
          fail("conflict", `${id} is ${task.status}: its reviewer can't change until the review loop ends`);
        }
      }
      return;
    }
    if (task.owner === actor) {
      const disallowed = fields.filter((field) => !OWNER_FIELDS.includes(field));
      if (disallowed.length > 0) {
        fail(
          "forbidden",
          `as ${id}'s owner you may change status, links and note only (not ${disallowed.join(", ")}); hand it off to reassign`,
        );
      }
      const status = input.status;
      if (status === undefined) return;
      // The reviewer holds a task in review; it moves on only with a verdict.
      if (task.status === "in_review") fail("conflict", `${id} is in review: answer it with a verdict`);
      if (status === "done" && task.reviewer === null) {
        this.assertMayMarkDone(task);
      } else if (!OWNER_STATUSES.includes(status)) {
        fail(
          "forbidden",
          status === "done"
            ? `${id} has a reviewer; send a review_request instead of marking it done`
            : `as ${id}'s owner you may set status to todo, in_progress or blocked${task.reviewer ? "" : " (or done)"}`,
        );
      }
      return;
    }
    if (task.assignee === actor) {
      const disallowed = fields.filter((field) => !NOTE_FIELDS.includes(field));
      if (disallowed.length > 0) {
        fail(
          "forbidden",
          `${id} is with ${task.owner ?? "nobody"} now; as its assignee you may add links and a note only (not ${disallowed.join(", ")})`,
        );
      }
      return;
    }
    fail("forbidden", `only the orchestrator, the human or ${id}'s current owner (${task.owner ?? "nobody"}) may update it`);
  }

  /** done needs an approved verdict for the current round, unless the task was never reviewed (DESIGN §10). */
  private assertMayMarkDone(task: TaskState): void {
    const id = taskId(task.num);
    if (task.round === 0 && task.reviewer === null) return;
    if (task.status === "in_review") fail("conflict", `${id} is in review: it is done when its reviewer approves it`);
    if (this.latestVerdict(id, task.round) !== "approved") {
      fail(
        "conflict",
        task.round === 0
          ? `${id} has a reviewer (${task.reviewer}); it can be marked done only after an approved verdict`
          : `${id} can be marked done only after an approved verdict for its current round (${task.round})`,
      );
    }
  }

  private applyStatus(task: TaskState, status: TaskStatus, now: number): void {
    const previous = task.status;
    task.status = status;
    if (isClosed(status)) {
      this.setOwner(task, null, now);
    } else if (status === "in_review") {
      if (!task.reviewer) fail("invalid_input", "set a reviewer before moving a task to in_review");
      this.setOwner(task, task.reviewer, now);
    } else if (status === "changes_requested" || previous === "in_review" || isClosed(previous)) {
      this.setOwner(task, task.assignee, now);
    }
  }

  private checkDependencies(ids: string[], self: number | null): string[] {
    for (const id of ids) {
      if (self !== null && idNumber(id) === self) fail("invalid_input", `${id} cannot depend on itself`);
      this.loadTask(id);
    }
    return [...new Set(ids)];
  }

  private latestVerdict(id: string, round: number): VerdictValue | null {
    const row = this.sql
      .exec<{ verdict: VerdictValue }>(
        "SELECT verdict FROM verdicts WHERE task_id = ? AND round = ? ORDER BY num DESC LIMIT 1",
        id,
        round,
      )
      .toArray()[0];
    return row?.verdict ?? null;
  }

  /** Appends links whose URL the task doesn't have yet; ledger_update (strict) refuses to pass the limit, messages keep the newest. */
  private addArtifacts(task: TaskState, links: Link[], strict: boolean): void {
    const fresh = uniqueLinks(links, task.artifacts);
    if (strict && task.artifacts.length + fresh.length > MAX_ARTIFACTS) {
      fail(
        "invalid_input",
        `${taskId(task.num)} has ${task.artifacts.length} artifacts; a task keeps at most ${MAX_ARTIFACTS} links (deduplicated by URL)`,
      );
    }
    task.artifacts.push(...fresh);
    if (task.artifacts.length > MAX_ARTIFACTS) task.artifacts.splice(0, task.artifacts.length - MAX_ARTIFACTS);
  }

  private addNote(task: TaskState, actor: Role, text: string, now: number): void {
    if (task.notes.length >= MAX_NOTES) {
      fail("invalid_input", `${taskId(task.num)} already has ${MAX_NOTES} notes, the most a task keeps`);
    }
    task.notes.push({ at: iso(now), by: actor, text });
  }

  /** Counts an agent's ledger_update or gate_request against its write burst limit (BURST_PER_MINUTE × 3 per 60 s). */
  private recordWrite(actor: Role, kind: "ledger_update" | "gate_request", now: number): void {
    if (!isAgent(actor)) return;
    const limit = this.config.burstPerMinute * WRITE_BURST_FACTOR;
    const n = this.count("SELECT COUNT(*) AS n FROM writes WHERE role = ? AND at_ms > ?", actor, now - 60_000);
    if (n >= limit) {
      fail(
        "rate_limited",
        `${actor} made ${n} ledger_update and gate_request calls in this build in the last 60 s (limit ${limit}); wait and retry`,
      );
    }
    this.sql.exec("INSERT INTO writes (role, kind, at_ms) VALUES (?, ?, ?)", actor, kind, now);
    // Only the last minute matters for the limit, and the newest row of each kind for activity.
    this.sql.exec(
      "DELETE FROM writes WHERE at_ms <= ? AND seq NOT IN (SELECT MAX(seq) FROM writes GROUP BY role, kind)",
      now - 60_000,
    );
  }

  // ---------------------------------------------------------------- task lifecycle

  /**
   * After a task closed (already saved): tasks waiting on it may now be ready, and the orchestrator is told
   * unless it closed the task itself (DESIGN §6, orchestrator notices).
   */
  private taskClosed(actor: Role, build: BuildRow, task: TaskState, notice: string, now: number): void {
    const id = taskId(task.num);
    this.releaseDependents(id, now);
    if (actor !== "orchestrator") {
      this.relayMessage("orchestrator", "status", notice + (this.isIdle(build) ? SIGNOFF_HINT : ""), now, { task_id: id });
    }
  }

  /** A task whose last open dependency just closed becomes ready: its idle clock starts now. */
  private releaseDependents(closedId: string, now: number): void {
    const statuses = this.taskStatuses();
    for (const task of this.loadTasks(`WHERE ${OPEN_TASK} ORDER BY num`)) {
      if (!task.depends_on.includes(closedId) || this.waitingOn(task, statuses).length > 0) continue;
      this.resetNudges(task, now);
      this.saveTask(task, now);
    }
  }

  /** An escalated task that is closed or leaves blocked by another route drops its pending escalation gate. */
  private releaseEscalation(actor: Role, before: TaskState, task: TaskState, now: number): void {
    if (!before.escalated || (task.status === "blocked" && task.escalated)) return;
    task.escalated = false;
    if (!isClosed(task.status) && task.owner === "human") this.setOwner(task, task.assignee, now);
    const id = taskId(task.num);
    for (const { num } of this.sql
      .exec<{ num: number }>("SELECT num FROM gates WHERE kind = 'escalation' AND status = 'pending' AND task_id = ?", id)
      .toArray()) {
      this.sql.exec("UPDATE gates SET status = 'cancelled' WHERE num = ?", num);
      this.audit(actor, "gate.cancelled", `G${num}`, { kind: "escalation", task_id: id, task_status: task.status }, now);
    }
  }

  private pendingEscalation(id: string): string | null {
    const row = this.sql
      .exec<{ num: number }>(
        "SELECT num FROM gates WHERE kind = 'escalation' AND status = 'pending' AND task_id = ? ORDER BY num LIMIT 1",
        id,
      )
      .toArray()[0];
    return row ? `G${row.num}` : null;
  }

  private assertNotEscalated(task: TaskState): void {
    const gate = this.pendingEscalation(taskId(task.num));
    if (gate) fail("conflict", `${taskId(task.num)} is escalated to ${this.human()} as ${gate}; wait for the decision`);
  }

  // ---------------------------------------------------------------- gates

  private applyGateRequest(actor: Role, input: ToolInput<"gate_request">): { gate: Gate; build: Build } {
    const now = Date.now();
    const build = this.loadBuild();
    this.assertNotKilled(actor);
    this.assertWritable(build, actor);
    this.recordWrite(actor, "gate_request", now);
    const plan = input.kind === "plan_approval";
    if (plan) {
      if (build.status !== "planning") {
        fail("conflict", `plan approval can be requested only while the build is planning (it is ${build.status})`);
      }
      if (this.count("SELECT COUNT(*) AS n FROM tasks") === 0) {
        fail("conflict", "add at least one task with ledger_update before requesting plan approval");
      }
    } else {
      if (build.status !== "in_progress") {
        fail("conflict", `final sign-off can be requested only while the build is in_progress (it is ${build.status})`);
      }
      const open = this.loadTasks(`WHERE ${OPEN_TASK} ORDER BY num`).map((task) => taskId(task.num));
      if (open.length > 0) {
        fail("conflict", `every task must be done or cancelled before final sign-off (still open: ${open.join(", ")})`);
      }
      const pending = this.pendingGates();
      if (pending[0]) fail("conflict", `gate ${pending[0].id} is still pending`);
    }

    const required = (plan ? build.gate_plan_approval : build.gate_final_signoff) === 1;
    const links = input.links ?? [];
    const gate = this.insertGate(
      {
        kind: input.kind,
        summary: input.summary,
        links,
        requested_by: actor,
        ...(required ? {} : { status: "approved", auto: true, decided_by: RELAY }),
      },
      now,
    );
    this.audit(actor, "gate.requested", gate.id, { kind: input.kind }, now);
    if (required) {
      this.setStatus(build, plan ? "awaiting_plan_approval" : "awaiting_signoff", actor, now);
      this.relayMessage(
        "human",
        "question",
        `${displayName(actor, this.config)} requests ${GATE_LABELS[input.kind]} (${gate.id}) for "${build.title}". ` +
          `Approve or reject it with gate_decide or on the ledger page.\n\n${input.summary}`,
        now,
        { links, on_behalf_of: actor === "human" ? null : actor },
      );
    } else {
      this.audit(RELAY, "gate.decided", gate.id, { kind: input.kind, decision: "approved", auto: true }, now);
      this.setStatus(build, plan ? "in_progress" : "shipped", RELAY, now);
      // The same decision message the human would send, so the orchestrator's next step is in its inbox.
      this.relayMessage(
        "orchestrator",
        "status",
        plan
          ? "Plan auto-approved (plan_approval gate is off). The build is in_progress: assign the first tasks."
          : "Final sign-off auto-approved (final_signoff gate is off). The build is shipped.",
        now,
      );
    }
    this.saveBuild(build, now);
    return { gate, build: this.buildOut(build) };
  }

  private applyGateDecision(actor: Role, input: ToolInput<"gate_decide">): GateDecision | { refused: string } {
    const now = Date.now();
    const build = this.loadBuild();
    if (CLOSED_BUILD_STATUSES.includes(build.status)) fail("conflict", `build ${build.build_id} is ${build.status}`);
    if (build.status === "halted") fail("conflict", "the build is halted; resume it before deciding gates");
    const row = this.sql.exec<GateRow>("SELECT * FROM gates WHERE num = ?", idNumber(input.gate_id)).toArray()[0];
    if (!row) fail("not_found", `gate ${input.gate_id} not found`);
    if (row.status !== "pending") fail("conflict", `gate ${input.gate_id} is already ${row.status}`);

    const approved = input.decision === "approved";
    const note = input.note ? `\n\nNote from ${this.human()}: ${input.note}` : "";
    const gateId = input.gate_id;
    const recipients: Role[] = ["orchestrator"];
    let body: string;
    let task: TaskState | null = null;
    let extraRounds: number | null = null;

    if (row.kind === "plan_approval") {
      this.setStatus(build, approved ? "in_progress" : "planning", actor, now);
      body = approved
        ? `Plan approved (${gateId}). The build is in_progress: assign the first tasks.`
        : `Plan rejected (${gateId}). The build is back in planning: revise the plan and request approval again.`;
    } else if (row.kind === "final_signoff") {
      this.setStatus(build, approved ? "shipped" : "in_progress", actor, now);
      body = approved
        ? `Final sign-off approved (${gateId}). The build is shipped.`
        : `Final sign-off rejected (${gateId}). The build is back in_progress.`;
    } else {
      if (row.task_id === null) fail("conflict", `escalation ${gateId} has no task`);
      task = this.loadTask(row.task_id);
      if (task.status !== "blocked" || !task.escalated) {
        // The task moved on by another route; the gate no longer applies.
        this.sql.exec("UPDATE gates SET status = 'cancelled' WHERE num = ?", row.num);
        this.audit(actor, "gate.cancelled", gateId, { kind: "escalation", task_id: row.task_id, task_status: task.status }, now);
        this.saveBuild(build, now);
        return { refused: `${row.task_id} is no longer escalated (it is ${task.status}), so ${gateId} was cancelled` };
      }
      const before = structuredClone(task);
      if (approved) {
        extraRounds = input.extra_rounds;
        task.max_rounds += extraRounds;
        task.status = "changes_requested";
        task.escalated = false;
        this.setOwner(task, task.assignee, now);
        body =
          `Escalation ${gateId} approved: ${label(task)} gets ${extraRounds} more review round(s) (max ${task.max_rounds}). ` +
          `${task.assignee} should address the requested changes and send a new review_request.`;
      } else {
        task.status = "cancelled";
        task.escalated = false;
        this.setOwner(task, null, now);
        body = `Escalation ${gateId} rejected: ${label(task)} is cancelled.`;
      }
      this.commitTask(actor, before, task, now);
      if (task.assignee !== "orchestrator" && task.assignee !== actor) recipients.push(task.assignee);
    }

    this.sql.exec(
      "UPDATE gates SET status = ?, decided_by = ?, decided_ms = ?, note = ?, extra_rounds = ? WHERE num = ?",
      input.decision,
      actor,
      now,
      input.note ?? null,
      extraRounds,
      row.num,
    );
    this.audit(actor, "gate.decided", gateId, { kind: row.kind, decision: input.decision }, now);
    for (const to of recipients) {
      this.insertMessage(
        { from: actor, to, type: "status", body: body + note, task_id: task ? taskId(task.num) : null },
        now,
      );
    }
    if (task && !approved) {
      const id = taskId(task.num);
      this.taskClosed(actor, build, task, `${id} was cancelled; create a narrower replacement task if the work is still needed.`, now);
    }
    this.saveBuild(build, now);
    const result: GateDecision = { gate: this.loadGate(gateId), build: this.buildOut(build) };
    if (task) result.task = this.taskOut(task);
    return result;
  }

  private insertGate(
    gate: {
      kind: GateKind;
      summary: string;
      links: Link[];
      requested_by: Actor;
      task_id?: string;
      status?: GateStatus;
      auto?: boolean;
      decided_by?: Actor;
    },
    now: number,
  ): Gate {
    const decided = gate.decided_by !== undefined;
    const row = this.sql
      .exec<GateRow>(
        `INSERT INTO gates (kind, status, task_id, summary, links, auto, requested_by, requested_ms, decided_by, decided_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        gate.kind,
        gate.status ?? "pending",
        gate.task_id ?? null,
        gate.summary,
        JSON.stringify(gate.links),
        gate.auto ? 1 : 0,
        gate.requested_by,
        now,
        decided ? gate.decided_by : null,
        decided ? now : null,
      )
      .one();
    return this.gateOut(row);
  }

  private loadGate(id: string): Gate {
    const row = this.sql.exec<GateRow>("SELECT * FROM gates WHERE num = ?", idNumber(id)).toArray()[0];
    if (!row) fail("not_found", `gate ${id} not found`);
    return this.gateOut(row);
  }

  private pendingGates(): Gate[] {
    return this.sql
      .exec<GateRow>("SELECT * FROM gates WHERE status = 'pending' ORDER BY num")
      .toArray()
      .map((row) => this.gateOut(row));
  }

  // ---------------------------------------------------------------- build_control

  private applyControl(actor: Role, input: ToolInput<"build_control">): { build: Build } {
    const now = Date.now();
    const build = this.loadBuild();
    const closed = CLOSED_BUILD_STATUSES.includes(build.status);
    if (closed) fail("conflict", `build ${build.build_id} is ${build.status}`);
    const by = displayName(actor, this.config);

    switch (input.action) {
      case "halt":
        if (build.status === "halted") fail("conflict", `build ${build.build_id} is already halted`);
        this.halt(build, input.reason ?? `halted by ${this.human()}`, actor, now);
        break;
      case "resume": {
        if (build.status !== "halted") fail("conflict", `build ${build.build_id} is not halted (it is ${build.status})`);
        if (build.message_count >= build.max_messages) {
          fail("conflict", `build ${build.build_id} is at its message cap (${build.max_messages}); raise it with set_caps first`);
        }
        const target = build.status_before_halt ?? "planning";
        const reason = build.halt_reason ?? "no reason given";
        build.status = target;
        build.status_before_halt = null;
        build.halt_reason = null;
        if (target === "in_progress") this.restartClocks(now);
        this.audit(actor, "build.resumed", build.build_id, { to: target }, now);
        this.lifecycleNotice(`Build resumed by ${by} (was halted: ${reason}). Carry on from the ledger.`, now);
        break;
      }
      case "cancel":
        this.audit(actor, "build.cancelled", build.build_id, { from: build.status, reason: input.reason ?? null }, now);
        build.status = "cancelled";
        build.status_before_halt = null;
        build.halt_reason = null;
        this.sql.exec("UPDATE gates SET status = 'cancelled' WHERE status = 'pending'");
        this.lifecycleNotice(`Build cancelled by ${by}${because(input.reason)} Stop work on it.`, now);
        break;
      case "set_caps": {
        const caps = input.caps ?? {};
        if (caps.max_messages === undefined && caps.max_review_rounds === undefined) {
          fail("invalid_input", "set_caps needs caps.max_messages and/or caps.max_review_rounds");
        }
        if (caps.max_messages !== undefined) build.max_messages = caps.max_messages;
        if (caps.max_review_rounds !== undefined) {
          // Open tasks keep any extra rounds the human granted on top of the build cap.
          const delta = caps.max_review_rounds - build.max_review_rounds;
          this.sql.exec(`UPDATE tasks SET max_rounds = MAX(1, max_rounds + ?) WHERE ${OPEN_TASK}`, delta);
          build.max_review_rounds = caps.max_review_rounds;
        }
        this.audit(
          actor,
          "build.caps_set",
          build.build_id,
          { max_messages: build.max_messages, max_review_rounds: build.max_review_rounds },
          now,
        );
        break;
      }
    }
    this.saveBuild(build, now);
    return { build: this.buildOut(build) };
  }

  private halt(build: BuildRow, reason: string, actor: Actor, now: number): void {
    this.audit(actor, "build.halted", build.build_id, { from: build.status, reason }, now);
    build.status_before_halt = build.status;
    build.status = "halted";
    build.halt_reason = reason;
  }

  /** A relay status to the orchestrator and to the owner of every open task (the human excepted). */
  private lifecycleNotice(body: string, now: number): void {
    const owners = this.loadTasks(`WHERE ${OPEN_TASK} AND owner IS NOT NULL ORDER BY num`).map((task) => task.owner as Role);
    for (const role of new Set<Role>(["orchestrator", ...owners])) {
      if (role !== "human") this.relayMessage(role, "status", body, now);
    }
  }

  /** Changes a gate-driven status; entering in_progress restarts the idle clocks so waiting time is not "idle". */
  private setStatus(build: BuildRow, status: BuildStatus, actor: Actor, now: number): void {
    this.audit(actor, "build.status", build.build_id, { from: build.status, to: status }, now);
    build.status = status;
    if (status === "in_progress") this.restartClocks(now);
  }

  private restartClocks(now: number): void {
    this.sql.exec(
      `UPDATE tasks SET last_activity_ms = ?, last_nudge_ms = CASE WHEN last_nudge_ms IS NULL THEN NULL ELSE ? END WHERE ${OPEN_TASK}`,
      now,
      now,
    );
    this.sql.exec(
      `UPDATE local_state SET idle_since_ms = ?,
         idle_last_nudge_ms = CASE WHEN idle_last_nudge_ms IS NULL THEN NULL ELSE ? END
       WHERE idle_since_ms IS NOT NULL`,
      now,
      now,
    );
  }

  // ---------------------------------------------------------------- inbox

  private readInbox(actor: Role, options: InboxOptions): InboxBuild {
    const now = Date.now();
    const build = this.loadBuild();
    const rows =
      options.since === undefined
        ? this.sql
            .exec<MessageRow>(
              "SELECT * FROM messages WHERE to_role = ? AND read_ms IS NULL ORDER BY seq LIMIT ?",
              actor,
              options.limit,
            )
            .toArray()
        : this.sql
            .exec<MessageRow>(
              "SELECT * FROM messages WHERE to_role = ? AND seq > ? ORDER BY seq LIMIT ?",
              actor,
              options.since,
              options.limit,
            )
            .toArray();
    const last = rows.at(-1)?.seq;
    let returnedUnread = rows.filter((row) => row.read_ms === null).length;
    if (!options.peek && last !== undefined) {
      this.sql.exec(
        "UPDATE messages SET read_ms = ? WHERE to_role = ? AND read_ms IS NULL AND seq > ? AND seq <= ?",
        now,
        actor,
        options.since ?? 0,
        last,
      );
      for (const row of rows) row.read_ms ??= now;
      returnedUnread = 0;
    }
    const unread = this.count("SELECT COUNT(*) AS n FROM messages WHERE to_role = ? AND read_ms IS NULL", actor);

    // A bare peek has no side effects; any other poll (or one naming its session) records presence.
    if (!options.peek || options.session_ref !== undefined) this.recordPoll(actor, options.session_ref ?? null, now);

    const statuses = this.taskStatuses();
    return {
      build_id: build.build_id,
      title: build.title,
      status: build.status,
      thread_key: `${build.build_id}/${actor}`,
      messages: rows.map((row) => this.messageOut(row)),
      unread_remaining: unread - returnedUnread,
      my_tasks: this.loadTasks(`WHERE (owner = ? OR assignee = ?) AND ${OPEN_TASK} ORDER BY num`, actor, actor).map(
        (task) => this.taskOut(task, statuses, true),
      ),
      pending_gates: this.pendingGates(),
      cursor: last ?? options.since ?? this.count("SELECT COALESCE(MAX(seq), 0) AS n FROM messages"),
    };
  }

  private recordPoll(actor: Role, sessionRef: string | null, now: number): void {
    this.sql.exec(
      `INSERT INTO threads (role, created_ms, last_poll_ms, session_ref) VALUES (?, ?, ?, ?)
       ON CONFLICT (role) DO UPDATE SET last_poll_ms = excluded.last_poll_ms,
         session_ref = COALESCE(excluded.session_ref, threads.session_ref)`,
      actor,
      now,
      now,
      sessionRef,
    );
  }

  // ---------------------------------------------------------------- nudges

  /**
   * What the nudger watches (DESIGN §8), with the next due time of each. A task: build in_progress, task open
   * and ready, owned by an agent role; due once the task AND its owner (any send or ledger_update in this
   * build) have been idle for NUDGE_AFTER_MINUTES. The idle build (in_progress, no open task, no pending gate)
   * is watched the same way for the orchestrator.
   */
  private nudgePlan(build: BuildRow): NudgeItem[] {
    if (build.status !== "in_progress") return [];
    const after = this.config.nudgeAfterMs;
    const activity = this.lastWrites();
    const statuses = this.taskStatuses();
    const plan: NudgeItem[] = [];
    const watch = (task: TaskState | null, owner: Role, count: number, lastNudge: number | null, since: number) => {
      if (count >= 2) return; // escalated; nothing more until the owner writes again
      const idleSince = Math.max(since, activity.get(owner) ?? 0);
      const due = count === 0 || lastNudge === null ? idleSince + after : lastNudge + after;
      plan.push({ task, owner, step: count === 0 ? 1 : 2, due, idleSince });
    };
    for (const task of this.loadTasks(`WHERE ${WATCHED_TASK} ORDER BY num`)) {
      if (this.waitingOn(task, statuses).length > 0) continue;
      watch(task, task.owner as Role, task.nudge_count, task.last_nudge_ms, task.last_activity_ms);
    }
    const local = this.localState();
    if (local.idle_since_ms !== null) {
      watch(null, "orchestrator", local.idle_nudge_count, local.idle_last_nudge_ms, local.idle_since_ms);
    }
    return plan;
  }

  private processNudges(now: number): void {
    const build = this.loadBuild();
    const due = this.nudgePlan(build).filter((item) => item.due <= now);
    if (due.length === 0) return;
    // One message per owner and step, listing every task of that owner that is due.
    const groups = new Map<string, NudgeItem[]>();
    for (const item of due) {
      const key = `${item.task ? item.owner : "build"}:${item.step}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const items of groups.values()) {
      const [first] = items as [NudgeItem, ...NudgeItem[]];
      if (first.task === null) this.nudgeIdleBuild(build, first, now);
      else if (first.step === 1) this.nudgeOwner(first.owner, items.map((item) => item.task as TaskState), now);
      else this.reportStalled(first.owner, items.map((item) => item.task as TaskState), now);
    }
    this.saveBuild(build, now);
  }

  private nudgeOwner(owner: Role, tasks: TaskState[], now: number): void {
    const [first] = tasks as [TaskState, ...TaskState[]];
    const idle = (task: TaskState) => formatDuration(now - task.last_activity_ms);
    let body: string;
    let copy: string;
    if (tasks.length === 1) {
      body =
        `Nudge: ${label(first)} has been idle for ${idle(first)}. You own it (status ${first.status}): post progress with ` +
        `send (type status), update it with ledger_update, or hand it off.`;
      copy = `Nudged ${owner}: ${label(first)} has been idle for ${idle(first)}.`;
    } else {
      const list = tasks.map((task) => `${label(task)} (${task.status}, idle ${idle(task)})`).join("; ");
      body =
        `Nudge: you own ${tasks.length} idle tasks: ${list}. Post progress with send (type status), update them with ` +
        `ledger_update, or hand them off.`;
      copy = `Nudged ${owner} about ${tasks.length} idle tasks: ${list}.`;
    }
    const id = taskId(first.num);
    this.relayMessage(owner, "status", body, now, { task_id: id, on_behalf_of: "orchestrator" });
    if (owner !== "orchestrator") this.relayMessage("orchestrator", "status", copy, now, { task_id: id });
    for (const task of tasks) {
      task.nudge_count = 1;
      task.last_nudge_ms = now;
      this.saveTask(task, now);
      this.audit(RELAY, "nudge.sent", taskId(task.num), { owner }, now);
    }
  }

  private reportStalled(owner: Role, tasks: TaskState[], now: number): void {
    const [first] = tasks as [TaskState, ...TaskState[]];
    const idle = formatDuration(now - Math.min(...tasks.map((task) => task.last_activity_ms)));
    const body = `Stalled: ${owner} missed two nudges on ${tasks.map(label).join(", ")} (idle for ${idle}).`;
    const id = taskId(first.num);
    this.relayMessage("human", "status", body, now, { task_id: id, on_behalf_of: "orchestrator" });
    this.relayMessage("orchestrator", "status", body, now, { task_id: id });
    for (const task of tasks) {
      task.nudge_count = 2;
      task.stalled = true;
      this.saveTask(task, now);
      this.audit(RELAY, "nudge.escalated", taskId(task.num), { owner }, now);
    }
  }

  /** The backstop for final sign-off: an in_progress build with no open task and no pending gate. */
  private nudgeIdleBuild(build: BuildRow, item: NudgeItem, now: number): void {
    const idle = formatDuration(now - item.idleSince);
    if (item.step === 1) {
      this.relayMessage("orchestrator", "status", `No open tasks for ${idle}: request final_signoff or add tasks.`, now);
      this.sql.exec("UPDATE local_state SET idle_nudge_count = 1, idle_last_nudge_ms = ?", now);
      this.audit(RELAY, "nudge.sent", build.build_id, { owner: "orchestrator", reason: "no open tasks" }, now);
      return;
    }
    const body =
      `Stalled: orchestrator missed two nudges on "${build.title}": no open tasks for ${idle} ` +
      `and final sign-off not requested.`;
    this.relayMessage("human", "status", body, now);
    this.relayMessage("orchestrator", "status", body, now);
    this.sql.exec("UPDATE local_state SET idle_nudge_count = 2");
    this.audit(RELAY, "nudge.escalated", build.build_id, { owner: "orchestrator", reason: "no open tasks" }, now);
  }

  /** Any send or ledger_update by an agent answers the nudges about what it owns (the idle build is the orchestrator's). */
  private answerNudges(actor: Role): void {
    this.sql.exec(
      "UPDATE tasks SET nudge_count = 0, last_nudge_ms = NULL, stalled = 0 WHERE owner = ? AND nudge_count > 0",
      actor,
    );
    if (actor === "orchestrator") this.sql.exec("UPDATE local_state SET idle_nudge_count = 0, idle_last_nudge_ms = NULL");
  }

  /** When each role last sent a message or updated the ledger in this build. */
  private lastWrites(): Map<Actor, number> {
    const rows = this.sql
      .exec<{ role: Actor; at: number }>(
        `SELECT role, MAX(at) AS at FROM (
           SELECT from_role AS role, MAX(created_ms) AS at FROM messages GROUP BY from_role
           UNION ALL
           SELECT role, MAX(at_ms) AS at FROM writes WHERE kind = 'ledger_update' GROUP BY role
         ) GROUP BY role`,
      )
      .toArray();
    return new Map(rows.map((row) => [row.role, row.at]));
  }

  /** In progress with no open task and no pending gate: the orchestrator's move (final sign-off or more tasks). */
  private isIdle(build: BuildRow): boolean {
    return (
      build.status === "in_progress" &&
      this.count(`SELECT COUNT(*) AS n FROM tasks WHERE ${OPEN_TASK}`) === 0 &&
      this.count("SELECT COUNT(*) AS n FROM gates WHERE status = 'pending'") === 0
    );
  }

  /** Starts or stops the idle-build watch (DESIGN §8) after every change to the build. */
  private watchIdleBuild(build: BuildRow, now: number): void {
    if (this.isIdle(build)) {
      this.sql.exec(
        "UPDATE local_state SET idle_since_ms = ?, idle_nudge_count = 0, idle_last_nudge_ms = NULL WHERE idle_since_ms IS NULL",
        now,
      );
    } else {
      this.sql.exec(
        "UPDATE local_state SET idle_since_ms = NULL, idle_nudge_count = 0, idle_last_nudge_ms = NULL WHERE idle_since_ms IS NOT NULL",
      );
    }
  }

  private resetNudges(task: TaskState, now: number): void {
    task.last_activity_ms = now;
    task.nudge_count = 0;
    task.last_nudge_ms = null;
    task.stalled = false;
  }

  /** Every ownership change resets the nudge state for the new owner. */
  private setOwner(task: TaskState, owner: Role | null, now: number): void {
    if (task.owner === owner) return;
    task.owner = owner;
    this.resetNudges(task, now);
  }

  // ---------------------------------------------------------------- rows

  private loadBuild(): BuildRow {
    const row = this.buildId === null ? undefined : this.sql.exec<BuildRow>("SELECT * FROM build").toArray()[0];
    if (!row) fail("not_found", "build not found");
    return row;
  }

  private saveBuild(build: BuildRow, now: number): void {
    build.rev += 1;
    build.updated_ms = now;
    this.sql.exec(
      `UPDATE build SET status = ?, status_before_halt = ?, halt_reason = ?, max_messages = ?, max_review_rounds = ?,
         message_count = ?, rev = ?, updated_ms = ?`,
      build.status,
      build.status_before_halt,
      build.halt_reason,
      build.max_messages,
      build.max_review_rounds,
      build.message_count,
      build.rev,
      build.updated_ms,
    );
    this.watchIdleBuild(build, now);
  }

  /** Agents cannot write to a halted build; nobody can write to a closed one. */
  private assertWritable(build: BuildRow, actor: Role): void {
    if (CLOSED_BUILD_STATUSES.includes(build.status)) fail("conflict", `build ${build.build_id} is ${build.status}`);
    if (build.status === "halted" && actor !== "human") {
      fail("halted", `build ${build.build_id} is halted (${build.halt_reason ?? "no reason given"}); wait for ${this.human()}`);
    }
  }

  /** The global kill switch as RelayDO last pushed it, checked inside the write's own transaction (DESIGN §7). */
  private assertNotKilled(actor: Role): void {
    if (!isAgent(actor)) return;
    const state = this.localState();
    if (state.global_halted === 1) {
      fail(
        "halted",
        `the global kill switch is on (${state.global_halt_reason ?? "no reason given"}); stop and wait for ${this.human()}`,
      );
    }
  }

  private recipient(actor: Role, name: string): Role {
    const to = resolveRole(name, this.config);
    if (!to) {
      fail(
        "invalid_input",
        name.trim().toLowerCase() === RELAY
          ? "relay is reserved for system messages"
          : `unknown role "${name}"; use one of: ${roleList()}`,
      );
    }
    if (to === actor) fail("invalid_input", "you cannot send a message to yourself");
    return to;
  }

  private roleArg(field: string, name: string): Role {
    const role = resolveRole(name, this.config);
    if (!role) fail("invalid_input", `${field}: unknown role "${name}"; use one of: ${roleList()}`);
    return role;
  }

  private loadTasks(clause: string, ...bindings: unknown[]): TaskState[] {
    return this.sql
      .exec<TaskRow>(`SELECT * FROM tasks ${clause}`, ...bindings)
      .toArray()
      .map((row) => ({
        ...row,
        artifacts: parseJson<Link[]>(row.artifacts, []),
        notes: parseJson<Note[]>(row.notes, []),
        depends_on: parseJson<string[]>(row.depends_on, []),
        stalled: row.stalled === 1,
        escalated: row.escalated === 1,
      }));
  }

  private loadTask(id: string): TaskState {
    const task = this.loadTasks("WHERE num = ?", idNumber(id))[0];
    if (!task) fail("not_found", `task ${id} not found`);
    return task;
  }

  /** Every task's status by id, for ready / waiting_on. */
  private taskStatuses(): Map<string, TaskStatus> {
    const rows = this.sql.exec<{ num: number; status: TaskStatus }>("SELECT num, status FROM tasks").toArray();
    return new Map(rows.map((row) => [taskId(row.num), row.status]));
  }

  /** The task's depends_on tasks that are not done or cancelled yet. */
  private waitingOn(task: TaskState, statuses: Map<string, TaskStatus>): string[] {
    return task.depends_on.filter((id) => {
      const status = statuses.get(id);
      return status === undefined || !isClosed(status);
    });
  }

  private assertTaskOpen(task: TaskState): void {
    if (isClosed(task.status)) {
      fail("conflict", `${taskId(task.num)} is ${task.status}; reopen it with ledger_update first`);
    }
  }

  private saveTask(task: TaskState, now: number): void {
    task.updated_ms = now;
    this.sql.exec(
      `UPDATE tasks SET title = ?, description = ?, assignee = ?, owner = ?, reviewer = ?, status = ?, round = ?,
         max_rounds = ?, artifacts = ?, notes = ?, depends_on = ?, last_activity_ms = ?, nudge_count = ?,
         last_nudge_ms = ?, stalled = ?, escalated = ?, updated_ms = ?
       WHERE num = ?`,
      task.title,
      task.description,
      task.assignee,
      task.owner,
      task.reviewer,
      task.status,
      task.round,
      task.max_rounds,
      JSON.stringify(task.artifacts),
      JSON.stringify(task.notes),
      JSON.stringify(task.depends_on),
      task.last_activity_ms,
      task.nudge_count,
      task.last_nudge_ms,
      task.stalled ? 1 : 0,
      task.escalated ? 1 : 0,
      task.updated_ms,
      task.num,
    );
  }

  /** Saves the task and audits what changed (before = null means it was just created). */
  private commitTask(actor: Actor, before: TaskState | null, task: TaskState, now: number): void {
    const id = taskId(task.num);
    if (before === null) {
      this.audit(actor, "task.created", id, { title: task.title, assignee: task.assignee }, now);
      return;
    }
    this.saveTask(task, now);
    const detail: AuditDetail = {};
    for (const field of AUDITED_TASK_FIELDS) {
      if (JSON.stringify(before[field]) !== JSON.stringify(task[field])) detail[field] = task[field];
    }
    if (task.artifacts.length !== before.artifacts.length) detail.artifacts = task.artifacts.length;
    if (task.notes.length !== before.notes.length) detail.notes = task.notes.length;
    if (Object.keys(detail).length > 0) this.audit(actor, "task.updated", id, detail, now);
  }

  private requireMessage(id: string): void {
    if (this.count("SELECT COUNT(*) AS n FROM messages WHERE seq = ?", idNumber(id)) === 0) {
      fail("not_found", `message ${id} not found in this build`);
    }
  }

  private insertMessage(message: NewMessage, now: number): Message {
    const row = this.sql
      .exec<MessageRow>(
        `INSERT INTO messages (from_role, to_role, type, task_id, next_task_id, body, links, verdict, changes, reply_to,
           on_behalf_of, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        message.from,
        message.to,
        message.type,
        message.task_id ?? null,
        message.next_task_id ?? null,
        message.body,
        JSON.stringify(message.links ?? []),
        message.verdict ?? null,
        message.changes ? JSON.stringify(message.changes) : null,
        message.reply_to ?? null,
        message.on_behalf_of ?? null,
        now,
      )
      .one();
    // The first message to a role in this build creates that role's thread row.
    this.sql.exec(
      `INSERT INTO threads (role, created_ms, last_message_ms) VALUES (?, ?, ?)
       ON CONFLICT (role) DO UPDATE SET last_message_ms = excluded.last_message_ms`,
      message.to,
      now,
      now,
    );
    this.audit(
      message.from,
      "message.sent",
      `M${row.seq}`,
      { type: message.type, to: message.to, task_id: message.task_id ?? null },
      now,
    );
    return this.messageOut(row);
  }

  private relayMessage(
    to: Role,
    type: MessageType,
    body: string,
    now: number,
    extra: Pick<NewMessage, "task_id" | "links" | "on_behalf_of"> = {},
  ): Message {
    return this.insertMessage({ from: RELAY, to, type, body, ...extra }, now);
  }

  private audit(actor: Actor, action: string, target: string | null, detail: AuditDetail | null, now: number): void {
    this.sql.exec(
      "INSERT INTO audit (at_ms, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
      now,
      actor,
      action,
      target,
      detail ? JSON.stringify(detail) : null,
    );
  }

  private count(query: string, ...bindings: unknown[]): number {
    return this.sql.exec<{ n: number }>(query, ...bindings).one().n;
  }

  // ---------------------------------------------------------------- output shapes

  private buildOut(row: BuildRow): Build {
    return {
      build_id: row.build_id,
      title: row.title,
      brief: row.brief,
      status: row.status,
      status_before_halt: row.status_before_halt,
      halt_reason: row.halt_reason,
      gates: { plan_approval: row.gate_plan_approval === 1, final_signoff: row.gate_final_signoff === 1 },
      caps: { max_messages: row.max_messages, max_review_rounds: row.max_review_rounds },
      message_count: row.message_count,
      created_by: row.created_by,
      created_at: iso(row.created_ms),
      updated_at: iso(row.updated_ms),
    };
  }

  private summaryOf(build: BuildRow): BuildSummary {
    const closed = CLOSED_BUILD_STATUSES.includes(build.status);
    const owners = closed
      ? []
      : this.loadTasks(`WHERE owner IS NOT NULL AND ${OPEN_TASK} ORDER BY num`).flatMap((task) =>
          task.owner ? [{ task_id: taskId(task.num), title: task.title, owner: task.owner, status: task.status }] : [],
        );
    const last = this.sql.exec<MessageRow>("SELECT * FROM messages ORDER BY seq DESC LIMIT 1").toArray()[0];
    return {
      build_id: build.build_id,
      title: build.title,
      status: build.status,
      halt_reason: build.halt_reason,
      owners,
      last_message: last
        ? {
            id: `M${last.seq}`,
            from: last.from_role,
            to: last.to_role,
            type: last.type,
            excerpt: excerpt(last.body),
            created_at: iso(last.created_ms),
          }
        : null,
      pending_gates: this.pendingGates(),
      created_at: iso(build.created_ms),
      updated_at: iso(build.updated_ms),
      rev: build.rev,
    };
  }

  /** Roles with unread messages, which RelayDO needs only once the build is closed (DESIGN §10, inbox). */
  private unreadRoles(build: BuildRow): Role[] {
    if (!CLOSED_BUILD_STATUSES.includes(build.status)) return [];
    return this.sql
      .exec<{ role: Role }>("SELECT DISTINCT to_role AS role FROM messages WHERE read_ms IS NULL ORDER BY to_role")
      .toArray()
      .map((row) => row.role);
  }

  /** slim (inbox my_tasks): only the newest artifacts and notes. */
  private taskOut(task: TaskState, statuses = this.taskStatuses(), slim = false): Task {
    const waiting = this.waitingOn(task, statuses);
    return {
      id: taskId(task.num),
      title: task.title,
      description: task.description,
      assignee: task.assignee,
      owner: task.owner,
      reviewer: task.reviewer,
      status: task.status,
      round: task.round,
      max_rounds: task.max_rounds,
      artifacts: slim ? task.artifacts.slice(-SLIM_ARTIFACTS) : task.artifacts,
      notes: slim ? task.notes.slice(-SLIM_NOTES) : task.notes,
      depends_on: task.depends_on,
      ready: waiting.length === 0,
      waiting_on: waiting,
      last_activity_at: iso(task.last_activity_ms),
      nudge_count: task.nudge_count,
      last_nudge_at: isoOrNull(task.last_nudge_ms),
      stalled: task.stalled,
      escalated: task.escalated,
      created_at: iso(task.created_ms),
      updated_at: iso(task.updated_ms),
    };
  }

  private messageOut(row: MessageRow): Message {
    return {
      id: `M${row.seq}`,
      seq: row.seq,
      build_id: this.buildId ?? "",
      from: row.from_role,
      to: row.to_role,
      type: row.type,
      task_id: row.task_id,
      next_task_id: row.next_task_id,
      body: row.body,
      links: parseJson<Link[]>(row.links, []),
      verdict: row.verdict,
      changes: parseJson<string[] | null>(row.changes, null),
      reply_to: row.reply_to,
      on_behalf_of: row.on_behalf_of,
      created_at: iso(row.created_ms),
      read_at: isoOrNull(row.read_ms),
    };
  }

  private gateOut(row: GateRow): Gate {
    return {
      id: `G${row.num}`,
      kind: row.kind,
      status: row.status,
      task_id: row.task_id,
      summary: row.summary,
      links: parseJson<Link[]>(row.links, []),
      auto: row.auto === 1,
      requested_by: row.requested_by,
      requested_at: iso(row.requested_ms),
      decided_by: row.decided_by,
      decided_at: isoOrNull(row.decided_ms),
      note: row.note,
      extra_rounds: row.extra_rounds,
    };
  }

  private verdictOut(row: VerdictRow): Verdict {
    return {
      id: `V${row.num}`,
      task_id: row.task_id,
      round: row.round,
      verdict: row.verdict,
      changes: parseJson<string[] | null>(row.changes, null),
      reviewer: row.reviewer,
      message_id: `M${row.message_seq}`,
      created_at: iso(row.created_ms),
    };
  }

  private threadOut(row: ThreadRow): Thread {
    return {
      thread_key: `${this.buildId}/${row.role}`,
      role: row.role,
      created_at: iso(row.created_ms),
      last_message_at: isoOrNull(row.last_message_ms),
      last_polled_at: isoOrNull(row.last_poll_ms),
      session_ref: row.session_ref,
    };
  }
}

/** links without repeated URLs, leaving out any URL already in `existing`. */
function uniqueLinks(links: Link[], existing: Link[] = []): Link[] {
  const seen = new Set(existing.map((link) => link.url));
  const out: Link[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out;
}

function auditOut(row: AuditRow): AuditEntry {
  return {
    seq: row.seq,
    at: iso(row.at_ms),
    actor: row.actor,
    action: row.action,
    target: row.target,
    detail: parseJson<AuditDetail | null>(row.detail, null),
  };
}
