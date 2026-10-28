import { z } from "zod";
import { MESSAGE_TYPES, REQUESTABLE_GATES, TASK_STATUSES, VERDICTS } from "./model";

const BuildId = z
  .string()
  .regex(/^b-[a-z2-7]{10}$/, "expected a build id like b-k3j5x2m7qa")
  .describe("Build id, e.g. b-k3j5x2m7qa");

const TaskId = z.string().regex(/^T[1-9]\d*$/, "expected a task id like T2").describe("Task id, e.g. T2");
const GateId = z.string().regex(/^G[1-9]\d*$/, "expected a gate id like G1").describe("Gate id, e.g. G1");
const MessageId = z.string().regex(/^M[1-9]\d*$/, "expected a message id like M7").describe("Message id, e.g. M7");

const RoleName = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "Role id or alias: orchestrator (orch), creative-director (cd, creative), developer (dev, full-stack-developer), human (james)",
  );

const LinkInput = z.object({
  url: z
    .url({ protocol: /^https?$/, error: "url must be an absolute http(s) URL" })
    .max(2000)
    .describe("http(s) URL the recipient can open"),
  label: z.string().max(200).optional(),
});

const Links = z.array(LinkInput).max(20).describe("Artifact links (preview URLs, specs, PRs); at most 20");
const Body = z.string().min(1).max(20_000);

const Caps = z.object({
  max_messages: z.int().min(1).max(10_000).optional().describe("Cap on agent-sent messages in this build"),
  max_review_rounds: z.int().min(1).max(20).optional().describe("Review rounds per task before escalation"),
});

export const schemas = {
  whoami: z.object({}),

  build_create: z.object({
    title: z.string().min(1).max(200),
    brief: Body.describe("The kickoff brief"),
    gates: z
      .object({
        plan_approval: z.boolean().optional().describe("Require the human to approve the plan (default true)"),
        final_signoff: z.boolean().optional().describe("Require the human to sign off before shipping (default true)"),
      })
      .optional(),
    caps: Caps.optional(),
  }),

  build_list: z.object({
    include_closed: z.boolean().optional().describe("Also list shipped and cancelled builds"),
  }),

  send: z.object({
    build_id: BuildId,
    to_role: RoleName,
    type: z.enum(MESSAGE_TYPES),
    body: Body,
    task_id: TaskId.optional().describe("Ledger task this message is about (required for work types)"),
    links: Links.optional(),
    verdict: z.enum(VERDICTS).optional().describe("Required for type verdict"),
    changes: z
      .array(z.string().min(1).max(2000))
      .min(1)
      .max(50)
      .optional()
      .describe("Numbered change list; required when verdict is changes_requested"),
    reply_to: MessageId.optional(),
  }),

  inbox: z.object({
    build_id: BuildId.optional().describe("Omit to read every active build"),
    since: z.int().min(0).optional().describe("Return messages with seq > since (read or not) instead of unread ones"),
    peek: z.boolean().optional().describe("Do not mark returned messages read"),
    limit: z.int().min(1).max(100).default(50),
    session_ref: z.string().min(1).max(200).optional().describe("Which session or thread is polling (presence)"),
  }),

  ledger_get: z.object({ build_id: BuildId }),

  ledger_update: z.object({
    build_id: BuildId,
    task_id: TaskId.optional().describe("Omit to create a task (orchestrator or human; title and assignee required)"),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    assignee: RoleName.optional(),
    reviewer: RoleName.nullable().optional().describe("Reviewing role; null clears it"),
    depends_on: z.array(TaskId).max(50).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    links: Links.optional().describe("Appended to the task's artifacts"),
    note: z.string().min(1).max(5000).optional().describe("Appended to the task's notes"),
  }),

  gate_request: z.object({
    build_id: BuildId,
    kind: z.enum(REQUESTABLE_GATES),
    summary: z.string().min(1).max(10_000),
    links: Links.optional(),
  }),

  gate_decide: z.object({
    build_id: BuildId,
    gate_id: GateId,
    decision: z.enum(["approved", "rejected"]),
    note: z.string().min(1).max(5000).optional(),
    extra_rounds: z.int().min(1).max(5).default(1).describe("Escalations only: review rounds to grant"),
  }),

  build_control: z.object({
    build_id: BuildId,
    action: z.enum(["halt", "resume", "cancel", "set_caps"]),
    reason: z.string().min(1).max(500).optional(),
    caps: Caps.optional().describe("Required for set_caps"),
  }),

  kill_switch: z.object({
    on: z.boolean(),
    reason: z.string().min(1).max(500).optional(),
  }),
};

export type ToolName = keyof typeof schemas;
export type ToolInput<N extends ToolName> = z.output<(typeof schemas)[N]>;

export const SpikeEventInput = z.object({
  event: z.string().min(1).max(200),
  ts: z.union([z.string().max(64), z.int().min(0).max(8.64e15)]).optional().describe("ISO time or epoch milliseconds"),
  session_id: z.string().min(1).max(200).optional(),
  surface: z.string().min(1).max(100).optional(),
  agent_id: z.string().min(1).max(200).optional(),
  detail: z.json().optional(),
});
export type SpikeEventInput = z.output<typeof SpikeEventInput>;

export const WakeInput = z.object({
  session_id: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(5000),
});
export type WakeInput = z.output<typeof WakeInput>;

/** Formats zod issues as one line, e.g. `body: Too small…; links[0].url: url must be…`. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path
        .map((part, index) => (typeof part === "number" ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`))
        .join("");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
