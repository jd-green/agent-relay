import type { Actor, Role } from "./roles";

export const BUILD_STATUSES = [
  "planning",
  "awaiting_plan_approval",
  "in_progress",
  "awaiting_signoff",
  "shipped",
  "cancelled",
  "halted",
] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
export const CLOSED_BUILD_STATUSES: readonly BuildStatus[] = ["shipped", "cancelled"];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "changes_requested",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export const MESSAGE_TYPES = ["task", "handoff", "review_request", "verdict", "question", "status"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
/** Types that move ledger state; agents may send them only while the build is in_progress. */
export const WORK_MESSAGE_TYPES: readonly MessageType[] = ["task", "handoff", "review_request", "verdict"];

export const VERDICTS = ["approved", "changes_requested"] as const;
export type VerdictValue = (typeof VERDICTS)[number];

export const REQUESTABLE_GATES = ["plan_approval", "final_signoff"] as const;
export type GateKind = (typeof REQUESTABLE_GATES)[number] | "escalation";
export type GateStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Link {
  url: string;
  label?: string;
}

export interface Note {
  at: string;
  by: Actor;
  text: string;
}

export interface Build {
  build_id: string;
  title: string;
  brief: string;
  status: BuildStatus;
  status_before_halt: BuildStatus | null;
  halt_reason: string | null;
  gates: { plan_approval: boolean; final_signoff: boolean };
  caps: { max_messages: number; max_review_rounds: number };
  message_count: number;
  created_by: Role;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  seq: number;
  build_id: string;
  from: Actor;
  to: Role;
  type: MessageType;
  task_id: string | null;
  /** handoff only: the task the recipient continues on (task_id is then the sender's finished task). */
  next_task_id: string | null;
  body: string;
  links: Link[];
  verdict: VerdictValue | null;
  changes: string[] | null;
  reply_to: string | null;
  on_behalf_of: Role | null;
  created_at: string;
  read_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: Role;
  owner: Role | null;
  reviewer: Role | null;
  status: TaskStatus;
  round: number;
  max_rounds: number;
  artifacts: Link[];
  notes: Note[];
  depends_on: string[];
  /** Every depends_on task is done or cancelled. */
  ready: boolean;
  /** The depends_on tasks still open. */
  waiting_on: string[];
  last_activity_at: string;
  nudge_count: number;
  last_nudge_at: string | null;
  stalled: boolean;
  escalated: boolean;
  created_at: string;
  updated_at: string;
}

export interface Gate {
  id: string;
  kind: GateKind;
  status: GateStatus;
  task_id: string | null;
  summary: string;
  links: Link[];
  auto: boolean;
  requested_by: Actor;
  requested_at: string;
  decided_by: Actor | null;
  decided_at: string | null;
  note: string | null;
  extra_rounds: number | null;
}

export interface Verdict {
  id: string;
  task_id: string;
  round: number;
  verdict: VerdictValue;
  changes: string[] | null;
  reviewer: Role;
  message_id: string;
  created_at: string;
}

export interface Thread {
  thread_key: string;
  role: Role;
  created_at: string;
  last_message_at: string | null;
  last_polled_at: string | null;
  session_ref: string | null;
}

export type AuditDetail = Record<string, string | number | boolean | null | string[]>;

export interface AuditEntry {
  seq: number;
  at: string;
  actor: Actor;
  action: string;
  target: string | null;
  detail: AuditDetail | null;
}

export interface BuildSummary {
  build_id: string;
  title: string;
  status: BuildStatus;
  halt_reason: string | null;
  owners: { task_id: string; title: string; owner: Role; status: TaskStatus }[];
  last_message: {
    id: string;
    from: Actor;
    to: Role;
    type: MessageType;
    excerpt: string;
    created_at: string;
  } | null;
  pending_gates: Gate[];
  created_at: string;
  updated_at: string;
  /** Monotonic revision so RelayDO never overwrites a newer summary with an older one. */
  rev: number;
}

export interface Halted {
  global: boolean;
  reason: string | null;
  at: string | null;
}

export interface InboxBuild {
  build_id: string;
  title: string;
  status: BuildStatus;
  thread_key: string;
  messages: Message[];
  unread_remaining: number;
  /** Open tasks the caller owns or is assigned, slimmed to the last 5 artifacts and the last 3 notes. */
  my_tasks: Task[];
  pending_gates: Gate[];
  cursor: number;
}

export interface Ledger {
  build: Build;
  tasks: Task[];
  gates: Gate[];
  verdicts: Verdict[];
  messages: Message[];
  threads: Thread[];
  audit: AuditEntry[];
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}
