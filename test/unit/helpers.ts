import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect } from "vitest";
import type { Role } from "../../src/roles";

export type { Role };

/** Tests inspect arbitrary JSON responses. */
export type Json = any;

export const TOKENS: Record<Role, string> = {
  orchestrator: env.ORCHESTRATOR_TOKEN ?? "",
  "creative-director": env.CREATIVE_DIRECTOR_TOKEN ?? "",
  developer: env.DEVELOPER_TOKEN ?? "",
  human: env.HUMAN_TOKEN ?? "",
};

/** Every test starts from empty storage and fresh Durable Object instances. */
export function useCleanState(): void {
  beforeEach(async () => {
    await reset();
  });
}

export function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://relay.test${path}`, init));
}

export interface ApiResult {
  status: number;
  body: Json;
}

export async function api(role: Role | null, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (role) headers.authorization = `Bearer ${TOKENS[role]}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchWorker(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Calls a tool through the JSON API and returns the raw envelope. */
export function callRaw(role: Role, tool: string, input: unknown = {}): Promise<ApiResult> {
  return api(role, "POST", `/api/call/${tool}`, input);
}

/** Calls a tool and returns its result, failing the test on an error envelope. */
export async function call(role: Role, tool: string, input: unknown = {}): Promise<Json> {
  const { status, body } = await callRaw(role, tool, input);
  if (status !== 200 || !body.ok) throw new Error(`${tool} as ${role} failed (${status}): ${JSON.stringify(body)}`);
  return body.result;
}

/** Expects a tool call to fail with the given code (and the code's HTTP status). */
export async function expectError(role: Role, tool: string, input: unknown, code: string): Promise<string> {
  const { status, body } = await callRaw(role, tool, input);
  expect(body?.error?.code, JSON.stringify(body)).toBe(code);
  expect(body.ok).toBe(false);
  expect(status).toBe(STATUS[code]);
  return body.error.message as string;
}

export const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  cap_reached: 429,
  halted: 423,
  secret_detected: 400,
};

export async function mcp(token: string | null, payload: unknown, path = "/mcp"): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetchWorker(path, {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

export async function rpc(role: Role, method: string, params?: unknown, id: number | string = 1): Promise<Json> {
  const response = await mcp(TOKENS[role], { jsonrpc: "2.0", id, method, params });
  expect(response.status).toBe(200);
  return response.json();
}

export function buildStub(buildId: string) {
  return env.BUILD.get(env.BUILD.idFromName(buildId));
}

export function relayStub() {
  return env.RELAY.get(env.RELAY.idFromName("global"));
}

/** Runs SQL inside a build's Durable Object (used to backdate timestamps). */
export function buildSql(buildId: string, query: string, ...bindings: unknown[]) {
  return runInDurableObject(buildStub(buildId), (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray());
}

export function relaySql(query: string, ...bindings: unknown[]) {
  return runInDurableObject(relayStub(), (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray());
}

export function runAlarm(buildId: string): Promise<boolean> {
  return runDurableObjectAlarm(buildStub(buildId));
}

/**
 * Lets time pass in a build by moving every clock back: task idle and nudge times, when each role last wrote
 * (messages and ledger writes) and the idle-build watch. No test-only code paths in the Worker.
 */
export function timeTravel(buildId: string, minutes: number) {
  const shift = minutes * 60_000;
  return runInDurableObject(buildStub(buildId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("UPDATE tasks SET last_activity_ms = last_activity_ms - ?, last_nudge_ms = last_nudge_ms - ?", shift, shift);
    sql.exec("UPDATE messages SET created_ms = created_ms - ?", shift);
    sql.exec("UPDATE writes SET at_ms = at_ms - ?", shift);
    sql.exec(
      "UPDATE local_state SET idle_since_ms = idle_since_ms - ?, idle_last_nudge_ms = idle_last_nudge_ms - ?",
      shift,
      shift,
    );
  });
}

/** Relay messages to `role` in the ledger's message tail, oldest first. */
export async function relayTo(buildId: string, role: Role): Promise<Json[]> {
  return (await ledger(buildId)).messages.filter((message: Json) => message.from === "relay" && message.to === role);
}

/** Reads (and marks read) `role`'s unread messages in one build. */
export async function readInbox(role: Role, buildId: string): Promise<Json[]> {
  return (await call(role, "inbox", { build_id: buildId, limit: 100 })).builds[0].messages;
}

export const PREVIEW = [{ url: "https://preview.example.com/build/1", label: "Preview" }];

/** Creates a build as the human (gates on unless overridden) and returns it. */
export async function createBuild(input: Record<string, unknown> = {}): Promise<Json> {
  return call("human", "build_create", { title: "Tip calculator", brief: "Build a tip calculator web app.", ...input });
}

export async function createTask(buildId: string, input: Record<string, unknown> = {}): Promise<string> {
  const { task } = await call("orchestrator", "ledger_update", {
    build_id: buildId,
    title: "Main screen",
    assignee: "developer",
    reviewer: "creative-director",
    ...input,
  });
  return task.id as string;
}

/** A build in in_progress with one task T1 (developer, reviewed by the creative director). */
export async function inProgressBuild(input: Record<string, unknown> = {}): Promise<{ buildId: string; taskId: string }> {
  const build = await createBuild({ gates: { plan_approval: false }, ...input });
  const taskId = await createTask(build.build_id);
  await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
  return { buildId: build.build_id, taskId };
}

export async function send(role: Role, input: Record<string, unknown>) {
  return call(role, "send", { body: "update", ...input });
}

export async function ledger(buildId: string) {
  return call("human", "ledger_get", { build_id: buildId });
}

export async function task(buildId: string, taskId: string) {
  const snapshot = await ledger(buildId);
  return snapshot.tasks.find((t: Json) => t.id === taskId);
}
