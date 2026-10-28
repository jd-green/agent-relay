import { describe, expect, it } from "vitest";
import { findSecret } from "../../src/secrets";
import { PREVIEW, TOKENS, call, callRaw, createBuild, inProgressBuild, send, useCleanState } from "./helpers";

useCleanState();

// Fake secrets are assembled at runtime so no secret-shaped literal sits in the repo.
const join = (...parts: string[]) => parts.join("");
const FAKES: Record<string, string> = {
  "Anthropic API key": join("sk-", "ant-", "api03-", "A1b2C3d4E5f6G7h8I9j0K1l2"),
  "OpenAI-style API key": join("sk-", "proj-", "a".repeat(20), "B".repeat(20)),
  "GitHub token": join("gh", "p_", "a1B2".repeat(9)),
  "AWS access key id": join("AK", "IA", "ABCDEFGH23456789"),
  "Slack token": join("xo", "xb-", "1234567890-abcdefghij"),
  "Google API key": join("AI", "za", "Sy", "A".repeat(33)),
  "Stripe live key": join("sk", "_live_", "abcdefghij0123456789"),
  "private key": join("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow..."),
  JWT: join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
};

describe("secret scanner", () => {
  it("detects every kind", () => {
    for (const [kind, value] of Object.entries(FAKES)) {
      expect(findSecret(`here it is: ${value} thanks`, [])?.kind, kind).toBe(kind);
    }
    expect(findSecret(join("github_", "pat_", "11ABCDEFG0123456789abcdef"), [])?.kind).toBe("GitHub token");
    expect(findSecret(join("rk", "_live_", "abcdefghij0123456789"), [])?.kind).toBe("Stripe live key");
  });

  it("detects configured role token values", () => {
    expect(findSecret(`use ${TOKENS.developer} to log in`, [TOKENS.developer])?.kind).toBe("relay role token");
  });

  it("allows op:// references and ordinary text", () => {
    expect(findSecret("Read it with op read op://Private/Anthropic/credential", [])).toBeNull();
    expect(findSecret(`token at op://Vault/${FAKES["Anthropic API key"]}/field`, [])).toBeNull();
    expect(findSecret("Task T2: risk-assessment-for-the-onboarding-flow-and-the-checkout-page", [])).toBeNull();
    expect(findSecret("Ship the AKIA tag and the eyJ prefix later", [])).toBeNull();
  });

  it("names the path of the first hit", () => {
    expect(findSecret({ links: [{ url: "https://a.example.com" }, { url: `https://b.example.com/?k=${FAKES["Google API key"]}` }] }, [])).toEqual({
      kind: "Google API key",
      path: "links[1].url",
    });
    expect(findSecret({ changes: ["ok", FAKES["Slack token"]] }, [])?.path).toBe("changes[1]");
  });
});

describe("secret_detected", () => {
  it("rejects secrets in message fields without echoing them", async () => {
    const { buildId, taskId } = await inProgressBuild();
    const base = { build_id: buildId, to_role: "creative-director", type: "status", body: "fine" };
    const cases = [
      { ...base, body: `key: ${FAKES["Anthropic API key"]}` },
      { ...base, links: [{ url: "https://example.com", label: FAKES["GitHub token"] }] },
      { ...base, body: `Use ${TOKENS.human}` },
    ];
    for (const input of cases) {
      const { status, body } = await callRaw("developer", "send", input);
      expect(status).toBe(400);
      expect(body.error.code).toBe("secret_detected");
      expect(JSON.stringify(body)).not.toContain(FAKES["Anthropic API key"]);
      expect(JSON.stringify(body)).not.toContain(TOKENS.human);
    }

    await send("developer", { build_id: buildId, to_role: "cd", type: "review_request", task_id: taskId, links: PREVIEW });
    const verdict = await callRaw("creative-director", "send", {
      ...base,
      to_role: "developer",
      type: "verdict",
      task_id: taskId,
      verdict: "changes_requested",
      changes: ["Fix contrast", `Rotate ${FAKES["AWS access key id"]}`],
    });
    expect(verdict.body.error).toEqual({
      code: "secret_detected",
      message: "changes[1] looks like it contains a secret (AWS access key id). Remove it and reference secrets by op:// path instead.",
    });
  });

  it("rejects secrets in task, gate and decision text", async () => {
    const build = await createBuild();
    const check = async (role: "orchestrator" | "human", tool: string, input: Record<string, unknown>) => {
      const { body } = await callRaw(role, tool, { build_id: build.build_id, ...input });
      expect(body.error?.code, tool).toBe("secret_detected");
    };
    await check("orchestrator", "ledger_update", { title: FAKES.JWT, assignee: "developer" });
    await check("orchestrator", "ledger_update", { title: "ok", assignee: "developer", description: FAKES["private key"] });
    await check("orchestrator", "ledger_update", { title: "ok", assignee: "developer", note: FAKES["Stripe live key"] });
    await call("orchestrator", "ledger_update", { build_id: build.build_id, title: "ok", assignee: "developer" });
    await check("orchestrator", "gate_request", { kind: "plan_approval", summary: FAKES["OpenAI-style API key"] });
    await call("orchestrator", "gate_request", { build_id: build.build_id, kind: "plan_approval", summary: "Plan" });
    await check("human", "gate_decide", { gate_id: "G1", decision: "approved", note: FAKES["Slack token"] });

    const create = await callRaw("human", "build_create", { title: "x", brief: `deploy with ${FAKES["Anthropic API key"]}` });
    expect(create.body.error.code).toBe("secret_detected");
  });
});
