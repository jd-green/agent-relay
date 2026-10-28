import { z } from "zod";
import type { Config } from "./config";
import { fail, unwrap } from "./errors";
import { CLOSED_BUILD_STATUSES } from "./model";
import { ROLES, displayName, enabledTokens, isAgent, resolveRole, roleDirectory, type Role } from "./roles";
import { describeIssues, schemas, type ToolInput, type ToolName } from "./schemas";
import { assertNoSecrets } from "./secrets";
import { buildStub, relayStub } from "./stubs";
import { VERSION } from "./version";

export interface ToolContext {
  env: Env;
  config: Config;
  /** Always derived from the caller's token, never from input. */
  role: Role;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface ToolSpec<N extends ToolName> {
  name: N;
  title: string;
  description: string;
  roles: readonly Role[];
  annotations: ToolAnnotations;
  /** Agent calls are refused while the global kill switch is on. */
  agentWrite: boolean;
  handler: (ctx: ToolContext, input: ToolInput<N>) => Promise<object>;
}

export interface Tool {
  name: ToolName;
  title: string;
  description: string;
  roles: readonly Role[];
  annotations: ToolAnnotations;
  agentWrite: boolean;
  schema: z.ZodType;
  run: (ctx: ToolContext, input: unknown) => Promise<object>;
}

function define<N extends ToolName>(spec: ToolSpec<N>): Tool {
  const { handler, ...meta } = spec;
  return { ...meta, schema: schemas[spec.name], run: (ctx, input) => handler(ctx, input as ToolInput<N>) };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ORCHESTRATOR_OR_HUMAN: readonly Role[] = ["orchestrator", "human"];
const HUMAN_ONLY: readonly Role[] = ["human"];

export const TOOLS: readonly Tool[] = [
  define({
    name: "whoami",
    title: "Who am I",
    description:
      "Returns the role your token maps to, the role directory (ids, display names and the aliases to_role accepts), " +
      "whether the global kill switch is on, and the relay version.",
    roles: ROLES,
    annotations: READ,
    agentWrite: false,
    handler: async (ctx) => ({
      role: ctx.role,
      display_name: displayName(ctx.role, ctx.config),
      roles: roleDirectory(ctx.env, ctx.config),
      halted: await relayStub(ctx.env).getKillSwitch(),
      version: VERSION,
    }),
  }),

  define({
    name: "build_create",
    title: "Create a build",
    description:
      "Start a build (one small app or feature carried to done by the roles). When the human creates it, the brief goes to " +
      "the orchestrator as a kickoff task message. Only a limited number of builds may be active at once. " +
      "gates.plan_approval and gates.final_signoff (default true) decide whether those steps wait for the human; only the " +
      "human may turn them off or raise caps above the defaults (the orchestrator may only lower caps).",
    roles: ORCHESTRATOR_OR_HUMAN,
    annotations: WRITE,
    agentWrite: true,
    handler: async (ctx, input) => unwrap(await relayStub(ctx.env).createBuild(ctx.role, input)),
  }),

  define({
    name: "build_list",
    title: "List builds",
    description:
      "Every build's status, current task owners, last message and pending gates. Shipped and cancelled builds are " +
      "left out unless include_closed is true.",
    roles: ROLES,
    annotations: READ,
    agentWrite: false,
    handler: async (ctx, input) => ({ builds: await relayStub(ctx.env).listBuilds(input.include_closed ?? false) }),
  }),

  define({
    name: "send",
    title: "Send a message",
    description:
      "Send a typed message to another role in a build; your sender identity comes from your token. Work types update " +
      "the ledger: task (orchestrator or the human assigns task_id to to_role), handoff (the task's owner passes it and its " +
      "links to to_role; with next_task_id, task_id is your finished task, which this closes, and to_role continues on " +
      "next_task_id), review_request (the owner asks the task's reviewer to review; needs at least one preview link; " +
      "refused while the task is already in review or out of rounds), verdict (the reviewer answers the task's assignee: " +
      "approved, or changes_requested with a numbered changes list). Agents may send work types only while the build is " +
      "in_progress, and none on a task escalated to the human. question and status have no ledger effect.",
    roles: ROLES,
    annotations: WRITE,
    agentWrite: true,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).send(ctx.role, input)),
  }),

  define({
    name: "inbox",
    title: "Read my inbox",
    description:
      "Call at the start of every turn. Returns messages addressed to you (unread ones, or every one after `since`), " +
      "marks them read unless peek is true, and lists your open tasks (with ready / waiting_on) and the pending gates " +
      "of each build. Omit build_id to read every active build, plus any shipped or cancelled build where you still " +
      "have unread messages. If halted.global is true the kill switch is on: stop working.",
    roles: ROLES,
    annotations: { ...WRITE, idempotentHint: false },
    agentWrite: false,
    handler: async (ctx, input) => {
      const relay = relayStub(ctx.env);
      const options = { peek: input.peek ?? false, limit: input.limit, session_ref: input.session_ref };
      if (input.build_id !== undefined) {
        const [halted, entry] = await Promise.all([
          relay.getKillSwitch(),
          buildStub(ctx.env, input.build_id).inbox(ctx.role, { ...options, since: input.since }),
        ]);
        return { role: ctx.role, halted, builds: [unwrap(entry)] };
      }
      // Across builds, `since` is ignored: seq numbers are per build.
      const [halted, ids] = await Promise.all([relay.getKillSwitch(), relay.inboxBuildIds(ctx.role)]);
      const entries = await Promise.all(ids.map((id) => buildStub(ctx.env, id).inbox(ctx.role, options)));
      // A closed build is listed only while it still has something for the caller.
      const builds = entries.flatMap((entry) =>
        entry.ok &&
        !(CLOSED_BUILD_STATUSES.includes(entry.result.status) && entry.result.messages.length === 0 && entry.result.unread_remaining === 0)
          ? [entry.result]
          : [],
      );
      return { role: ctx.role, halted, builds };
    },
  }),

  define({
    name: "ledger_get",
    title: "Read a build's ledger",
    description:
      "The full ledger of one build: build, tasks, gates, verdicts, the last 50 messages between all roles, threads " +
      "(who polled when) and the last 50 audit entries.",
    roles: ROLES,
    annotations: READ,
    agentWrite: false,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).snapshot()),
  }),

  define({
    name: "ledger_update",
    title: "Create or update a task",
    description:
      "Without task_id, creates a task (orchestrator or the human; title and assignee required; the assignee becomes the " +
      "owner; build must be planning or in_progress). With task_id: the orchestrator may change any field and any status " +
      "except in_review/changes_requested (those come from review_request and verdict messages); done needs an approved " +
      "verdict for the current round once a task has a reviewer or a review. The task's current owner may set status " +
      "todo, in_progress or blocked (or done when the task has no reviewer) and add links and a note, but a reviewer " +
      "never changes the status of a task in review (send the verdict). Its assignee may add links and a note at any " +
      "time. links are appended to artifacts (deduplicated, at most 50) and note to notes (at most 50).",
    roles: ROLES,
    annotations: WRITE,
    agentWrite: true,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).updateTask(ctx.role, input)),
  }),

  define({
    name: "gate_request",
    title: "Request a gate",
    description:
      "Ask the human to approve a gate. plan_approval: the build must be planning and have at least one task. " +
      "final_signoff: the build must be in_progress, every task done or cancelled, and no gate pending. If the build " +
      "has that gate turned off it is approved automatically.",
    roles: ORCHESTRATOR_OR_HUMAN,
    annotations: WRITE,
    agentWrite: true,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).requestGate(ctx.role, input)),
  }),

  define({
    name: "gate_decide",
    title: "Decide a gate",
    description:
      "Approve or reject a pending gate. plan_approval: in_progress, or back to planning. final_signoff: shipped, or " +
      "back to in_progress. escalation: grant extra_rounds more review rounds, or cancel the task (the orchestrator can " +
      "plan a narrower one). The orchestrator (and for escalations the assignee) is told.",
    roles: HUMAN_ONLY,
    annotations: WRITE,
    agentWrite: false,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).decideGate(ctx.role, input)),
  }),

  define({
    name: "build_control",
    title: "Control a build",
    description:
      "Halt, resume or cancel a build, or change its caps (set_caps with caps). Resume and cancel tell the orchestrator " +
      "and the owner of every open task.",
    roles: HUMAN_ONLY,
    annotations: { ...WRITE, destructiveHint: true },
    agentWrite: false,
    handler: async (ctx, input) => unwrap(await buildStub(ctx.env, input.build_id).control(ctx.role, input)),
  }),

  define({
    name: "kill_switch",
    title: "Global kill switch",
    description:
      "on: true stops every agent write in every build and pauses nudges; inbox keeps answering with " +
      "halted.global = true. on: false clears it and tells the orchestrator and every open task's owner to carry on.",
    roles: HUMAN_ONLY,
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    agentWrite: false,
    handler: async (ctx, input) => ({ halted: await relayStub(ctx.env).setKillSwitch(ctx.role, input.on, input.reason) }),
  }),
];

const TOOLS_BY_NAME = new Map<string, Tool>(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): Tool | undefined {
  return TOOLS_BY_NAME.get(name);
}

export function toolsFor(role: Role): Tool[] {
  return TOOLS.filter((tool) => tool.roles.includes(role));
}

// Input fields that would name a sender. The sender is always the token's role.
const SENDER_FIELDS = ["from", "from_role", "sender", "sender_role", "as_role", "role", "actor", "on_behalf_of"];

function rejectImpersonation(ctx: ToolContext, input: Record<string, unknown>): void {
  for (const field of SENDER_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && resolveRole(value, ctx.config) === ctx.role) continue;
    fail("forbidden", `the sender is always your token's role (${ctx.role}); remove "${field}"`);
  }
}

/** Validates and runs a tool as ctx.role. Throws RelayError on any failure. */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<object> {
  const tool = findTool(name);
  if (!tool) fail("not_found", `unknown tool "${name}"`);
  if (!tool.roles.includes(ctx.role)) fail("forbidden", `${ctx.role} may not call ${name}`);
  const input = args ?? {};
  if (typeof input !== "object" || Array.isArray(input)) fail("invalid_input", "tool arguments must be a JSON object");
  rejectImpersonation(ctx, input as Record<string, unknown>);
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) fail("invalid_input", describeIssues(parsed.error));
  assertNoSecrets(parsed.data, enabledTokens(ctx.env));
  if (tool.agentWrite && isAgent(ctx.role)) {
    const halted = await relayStub(ctx.env).getKillSwitch();
    if (halted.global) {
      fail(
        "halted",
        `the global kill switch is on (${halted.reason ?? "no reason given"}); stop and wait for ${displayName("human", ctx.config)}`,
      );
    }
  }
  return tool.run(ctx, parsed.data);
}

const jsonSchemas = new Map<ToolName, object>();

export function inputSchema(tool: Tool): object {
  let schema = jsonSchemas.get(tool.name);
  if (!schema) {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(tool.schema, { io: "input" });
    schema = rest;
    jsonSchemas.set(tool.name, schema);
  }
  return schema;
}
