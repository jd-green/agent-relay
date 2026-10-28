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
  read_ms INTEGER
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

/** Tasks the nudger watches (the build must also be in_progress). */
const NUDGEABLE = "status NOT IN ('done', 'cancelled') AND owner IS NOT NULL AND owner <> 'human' AND nudge_count < 2";
const OPEN_TASK = "status NOT IN ('done', 'cancelled')";
const LEDGER_TAIL = 50;
const EXCERPT_LENGTH = 140;

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
  links?: Link[];
  verdict?: VerdictValue | null;
  changes?: string[] | null;
  reply_to?: string | null;
  on_behalf_of?: Role | null;
}

export interface InitInput {
  build_id: string;
  title: string;
  brief: string;
  gates?: { plan_approval?: boolean; final_signoff?: boolean };
  caps?: { max_messages?: number; max_review_rounds?: number };
  created_by: Role;
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
  gate?: Gate;
}

type SendInput = ToolInput<"send">;
type LedgerUpdateInput = ToolInput<"ledger_update">;

const UPDATE_FIELDS = ["title", "description", "assignee", "reviewer", "depends_on", "status", "links", "note"] as const;
type UpdateField = (typeof UPDATE_FIELDS)[number];
const OWNER_FIELDS: readonly UpdateField[] = ["status", "links", "note"];
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.config = loadConfig(env);
    const hasSchema = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'build'").toArray();
    if (hasSchema.length > 0) {
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

  decideGate(
    actor: Role,
    input: ToolInput<"gate_decide">,
  ): Promise<Outcome<{ gate: Gate; build: Build; task?: Task }>> {
    return this.write(() => this.applyGateDecision(actor, input));
  }

  control(actor: Role, input: ToolInput<"build_control">): Promise<Outcome<{ build: Build }>> {
    return this.write(() => this.applyControl(actor, input));
  }

  inbox(actor: Role, options: InboxOptions): Outcome<InboxBuild> {
    return this.mutate(() => this.readInbox(actor, options));
  }

  snapshot(): Outcome<Ledger> {
    return capture(() => {
      const build = this.loadBuild();
      return {
        build: this.buildOut(build),
        tasks: this.loadTasks("ORDER BY num").map((task) => this.taskOut(task)),
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

  /** Called by RelayDO when the global kill switch is turned off: idle time during the halt does not count. */
  async killSwitchCleared(): Promise<void> {
    if (this.buildId === null) return;
    this.mutate(() => {
      if (this.loadBuild().status === "in_progress") this.restartClocks(Date.now());
    });
    await this.reschedule();
  }

  override async alarm(): Promise<void> {
    if (this.buildId === null) return;
    const halted = await relayStub(this.env).getKillSwitch();
    if (halted.global) {
      // Nudges pause while the kill switch is on; look again later in case the "off" notice is missed.
      if (this.nextNudgeDue() !== null) await this.ctx.storage.setAlarm(Date.now() + this.config.nudgeAfterMs);
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
    try {
      await relayStub(this.env).putSummary(this.summaryOf(this.loadBuild()));
    } catch (err) {
      // The write already committed; a stale registry row is corrected by the next change.
      console.error("pushing build summary to RelayDO failed", err);
    }
  }

  private async reschedule(): Promise<void> {
    const due = this.nextNudgeDue();
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }

  private nextNudgeDue(): number | null {
    if (this.loadBuild().status !== "in_progress") return null;
    const { due } = this.sql
      .exec<{ due: number | null }>(
        `SELECT MIN(CASE nudge_count WHEN 0 THEN last_activity_ms ELSE last_nudge_ms END) AS due FROM tasks WHERE ${NUDGEABLE}`,
      )
      .one();
    return due === null ? null : due + this.config.nudgeAfterMs;
  }

  private human(): string {
    return displayName("human", this.config);
  }

  // ---------------------------------------------------------------- init

  private createBuild(input: InitInput): { build: Build; summary: BuildSummary } {
    const now = Date.now();
    this.sql.exec(SCHEMA);
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
    this.assertWritable(build, actor);
    const to = this.recipient(actor, input.to_role);
    if (isAgent(actor) && WORK_MESSAGE_TYPES.includes(input.type) && build.status !== "in_progress") {
      fail("conflict", `${input.type} messages are accepted only while the build is in_progress (it is ${build.status})`);
    }
    if (input.type !== "verdict" && (input.verdict !== undefined || input.changes !== undefined)) {
      fail("invalid_input", "verdict and changes belong on verdict messages only");
    }
    if (input.reply_to !== undefined) this.requireMessage(input.reply_to);
    const task = input.task_id === undefined ? null : this.loadTask(input.task_id);
    const links = input.links ?? [];
    this.validateSend(actor, input, task, links);
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
        links,
        verdict: input.verdict,
        changes: input.changes,
        reply_to: input.reply_to,
      },
      now,
    );
    let gate: Gate | null = null;
    if (task) {
      const before = structuredClone(task);
      // A message from the task's current owner is activity on that task.
      if (task.owner === actor) this.resetNudges(task, now);
      gate = this.applySendEffects(actor, to, input, task, message, links, now);
      this.commitTask(actor, before, task, now);
    }
    this.saveBuild(build, now);
    const result: SendResult = { message };
    if (task) result.task = this.taskOut(task);
    if (gate) result.gate = gate;
    return result;
  }

  private validateSend(actor: Role, input: SendInput, task: TaskState | null, links: Link[]): void {
    const elevated = actor === "orchestrator" || actor === "human";
    const type = input.type;
    if (type === "question" || type === "status") return;
    if (type === "task" && !task) {
      if (actor !== "human") fail("invalid_input", "task messages need a task_id (create the task with ledger_update first)");
      return;
    }
    if (!task) fail("invalid_input", `${type} messages need a task_id`);
    const id = taskId(task.num);

    switch (type) {
      case "task":
      case "handoff":
        if (type === "task" && !elevated) fail("forbidden", "only the orchestrator or the human may send task messages");
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
        if (!elevated && task.owner !== actor) {
          fail("forbidden", `only ${id}'s current owner (${task.owner ?? "nobody"}), the orchestrator or the human may request review`);
        }
        if (task.status === "blocked" || CLOSED_TASK_STATUSES.includes(task.status)) {
          fail("conflict", `${id} is ${task.status} and cannot go to review`);
        }
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
        return;
    }
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
  ): Gate | null {
    switch (input.type) {
      case "task":
        task.assignee = to;
        this.setOwner(task, to, now);
        if (task.status === "blocked") task.status = "todo";
        return null;
      case "handoff":
        task.assignee = to;
        this.setOwner(task, to, now);
        task.status = "todo";
        task.artifacts.push(...links);
        return null;
      case "review_request":
        task.round += 1;
        task.reviewer = to;
        this.setOwner(task, to, now);
        task.status = "in_review";
        task.artifacts.push(...links);
        return null;
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
          return null;
        }
        if (task.round >= task.max_rounds) return this.escalate(actor, task, input.changes ?? [], now);
        task.status = "changes_requested";
        this.setOwner(task, task.assignee, now);
        return null;
      }
      default:
        return null;
    }
  }

  /** The review cap was hit: block the task, hand it to the human and open an escalation gate. */
  private escalate(reviewer: Role, task: TaskState, changes: string[], now: number): Gate {
    const id = taskId(task.num);
    const label = `${id} "${task.title}"`;
    task.status = "blocked";
    task.escalated = true;
    this.setOwner(task, "human", now);
    const gate = this.insertGate(
      {
        kind: "escalation",
        task_id: id,
        summary: `${label} reached ${task.round} review rounds without approval.`,
        links: task.artifacts.slice(-3),
        requested_by: RELAY,
      },
      now,
    );
    this.relayMessage(
      "human",
      "question",
      `Escalation ${gate.id}: ${label} has had ${task.round} review rounds without approval. ` +
        `Approve ${gate.id} to grant more rounds, or reject it to send the task back to the orchestrator.\n\n` +
        `Latest changes requested by ${reviewer}:\n${numbered(changes)}`,
      now,
      { task_id: id, on_behalf_of: "orchestrator", links: gate.links },
    );
    this.relayMessage(
      "orchestrator",
      "status",
      `${label} hit the review cap (${task.max_rounds} rounds) and was escalated to ${this.human()} as ${gate.id}.`,
      now,
      { task_id: id },
    );
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
    this.assertWritable(build, actor);
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
      if (task.status !== "in_review" && !CLOSED_TASK_STATUSES.includes(task.status)) {
        this.setOwner(task, task.assignee, now);
      }
    }
    if (input.reviewer !== undefined) {
      task.reviewer = input.reviewer === null ? null : this.roleArg("reviewer", input.reviewer);
      if (task.status === "in_review" && task.reviewer) this.setOwner(task, task.reviewer, now);
    }
    if (input.status !== undefined) this.applyStatus(task, input.status, now);
    if (input.links) task.artifacts.push(...input.links);
    if (input.note !== undefined) task.notes.push({ at: iso(now), by: actor, text: input.note });
    // An update by the task's owner is activity on that task.
    if (before.owner === actor) this.resetNudges(task, now);

    this.commitTask(actor, before, task, now);
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
        JSON.stringify(input.links ?? []),
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
      if (input.status === "in_review" || input.status === "changes_requested") {
        fail("forbidden", `${input.status} is set by review_request and verdict messages, not ledger_update`);
      }
      if (input.status === "done" && task.reviewer && this.latestVerdict(id) !== "approved") {
        fail("conflict", `${id} has a reviewer (${task.reviewer}); it can be marked done only after an approved verdict`);
      }
      return;
    }
    if (task.owner !== actor) {
      fail("forbidden", `only the orchestrator, the human or ${id}'s current owner (${task.owner ?? "nobody"}) may update it`);
    }
    const disallowed = fields.filter((field) => !OWNER_FIELDS.includes(field));
    if (disallowed.length > 0) {
      fail(
        "forbidden",
        `as ${id}'s owner you may change status, links and note only (not ${disallowed.join(", ")}); hand it off to reassign`,
      );
    }
    const status = input.status;
    if (status !== undefined && !OWNER_STATUSES.includes(status) && !(status === "done" && task.reviewer === null)) {
      fail(
        "forbidden",
        status === "done"
          ? `${id} has a reviewer; send a review_request instead of marking it done`
          : `as ${id}'s owner you may set status to todo, in_progress or blocked${task.reviewer ? "" : " (or done)"}`,
      );
    }
  }

  private applyStatus(task: TaskState, status: TaskStatus, now: number): void {
    const previous = task.status;
    task.status = status;
    if (CLOSED_TASK_STATUSES.includes(status)) {
      this.setOwner(task, null, now);
    } else if (status === "in_review") {
      if (!task.reviewer) fail("invalid_input", "set a reviewer before moving a task to in_review");
      this.setOwner(task, task.reviewer, now);
    } else if (status === "changes_requested" || previous === "in_review" || CLOSED_TASK_STATUSES.includes(previous)) {
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

  private latestVerdict(id: string): VerdictValue | null {
    const row = this.sql
      .exec<{ verdict: VerdictValue }>("SELECT verdict FROM verdicts WHERE task_id = ? ORDER BY num DESC LIMIT 1", id)
      .toArray()[0];
    return row?.verdict ?? null;
  }

  // ---------------------------------------------------------------- gates

  private applyGateRequest(actor: Role, input: ToolInput<"gate_request">): { gate: Gate; build: Build } {
    const now = Date.now();
    const build = this.loadBuild();
    this.assertWritable(build, actor);
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
    }
    this.saveBuild(build, now);
    return { gate, build: this.buildOut(build) };
  }

  private applyGateDecision(
    actor: Role,
    input: ToolInput<"gate_decide">,
  ): { gate: Gate; build: Build; task?: Task } {
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
      const before = structuredClone(task);
      const label = `${taskId(task.num)} "${task.title}"`;
      if (approved) {
        extraRounds = input.extra_rounds;
        task.max_rounds += extraRounds;
        task.status = "changes_requested";
        task.escalated = false;
        this.setOwner(task, task.assignee, now);
        body =
          `Escalation ${gateId} approved: ${label} gets ${extraRounds} more review round(s) (max ${task.max_rounds}). ` +
          `${task.assignee} should address the requested changes and send a new review_request.`;
      } else {
        this.setOwner(task, "orchestrator", now);
        body = `Escalation ${gateId} rejected: ${label} stays blocked and is back with the orchestrator to re-plan.`;
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
    this.saveBuild(build, now);
    const result: { gate: Gate; build: Build; task?: Task } = {
      gate: this.loadGate(gateId),
      build: this.buildOut(build),
    };
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

    switch (input.action) {
      case "halt":
        if (build.status === "halted") fail("conflict", `build ${build.build_id} is already halted`);
        this.halt(build, input.reason ?? `halted by ${this.human()}`, actor, now);
        break;
      case "resume": {
        if (build.status !== "halted") fail("conflict", `build ${build.build_id} is not halted (it is ${build.status})`);
        const target = build.status_before_halt ?? "planning";
        build.status = target;
        build.status_before_halt = null;
        build.halt_reason = null;
        if (target === "in_progress") this.restartClocks(now);
        this.audit(actor, "build.resumed", build.build_id, { to: target }, now);
        break;
      }
      case "cancel":
        this.audit(actor, "build.cancelled", build.build_id, { from: build.status, reason: input.reason ?? null }, now);
        build.status = "cancelled";
        build.status_before_halt = null;
        build.halt_reason = null;
        this.sql.exec("UPDATE gates SET status = 'cancelled' WHERE status = 'pending'");
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

    return {
      build_id: build.build_id,
      title: build.title,
      status: build.status,
      thread_key: `${build.build_id}/${actor}`,
      messages: rows.map((row) => this.messageOut(row)),
      unread_remaining: unread - returnedUnread,
      my_tasks: this.loadTasks(`WHERE (owner = ? OR assignee = ?) AND ${OPEN_TASK} ORDER BY num`, actor, actor).map(
        (task) => this.taskOut(task),
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

  private processNudges(now: number): void {
    const build = this.loadBuild();
    if (build.status !== "in_progress") return;
    const after = this.config.nudgeAfterMs;
    let changed = false;
    for (const task of this.loadTasks(`WHERE ${NUDGEABLE} ORDER BY num`)) {
      const owner = task.owner;
      if (owner === null) continue;
      const id = taskId(task.num);
      const label = `${id} "${task.title}"`;
      const idle = formatDuration(now - task.last_activity_ms);
      if (task.nudge_count === 0 && now - task.last_activity_ms >= after) {
        this.relayMessage(
          owner,
          "status",
          `Nudge: ${label} has been idle for ${idle}. You own it (status ${task.status}): post progress with send (type status), ` +
            `update it with ledger_update, or hand it off.`,
          now,
          { task_id: id, on_behalf_of: "orchestrator" },
        );
        if (owner !== "orchestrator") {
          this.relayMessage("orchestrator", "status", `Nudged ${owner}: ${label} has been idle for ${idle}.`, now, {
            task_id: id,
          });
        }
        task.nudge_count = 1;
        task.last_nudge_ms = now;
        this.audit(RELAY, "nudge.sent", id, { owner }, now);
      } else if (task.nudge_count === 1 && task.last_nudge_ms !== null && now - task.last_nudge_ms >= after) {
        const body = `Stalled: ${owner} missed two nudges on ${label} (idle for ${idle}).`;
        this.relayMessage("human", "status", body, now, { task_id: id, on_behalf_of: "orchestrator" });
        this.relayMessage("orchestrator", "status", body, now, { task_id: id });
        task.nudge_count = 2;
        task.stalled = true;
        this.audit(RELAY, "nudge.escalated", id, { owner }, now);
      } else {
        continue;
      }
      this.saveTask(task, now);
      changed = true;
    }
    if (changed) this.saveBuild(build, now);
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
  }

  /** Agents cannot write to a halted build; nobody can write to a closed one. */
  private assertWritable(build: BuildRow, actor: Role): void {
    if (CLOSED_BUILD_STATUSES.includes(build.status)) fail("conflict", `build ${build.build_id} is ${build.status}`);
    if (build.status === "halted" && actor !== "human") {
      fail("halted", `build ${build.build_id} is halted (${build.halt_reason ?? "no reason given"}); wait for ${this.human()}`);
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

  private assertTaskOpen(task: TaskState): void {
    if (CLOSED_TASK_STATUSES.includes(task.status)) {
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
        `INSERT INTO messages (from_role, to_role, type, task_id, body, links, verdict, changes, reply_to, on_behalf_of, created_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        message.from,
        message.to,
        message.type,
        message.task_id ?? null,
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

  private taskOut(task: TaskState): Task {
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
      artifacts: task.artifacts,
      notes: task.notes,
      depends_on: task.depends_on,
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
