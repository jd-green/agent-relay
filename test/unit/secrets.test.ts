import { describe, expect, it } from "vitest";
import { findSecret } from "../../src/secrets";
import { PREVIEW, TOKENS, api, call, callRaw, createBuild, inProgressBuild, send, useCleanState } from "./helpers";

useCleanState();

// Fake secrets are assembled at runtime so no secret-shaped literal sits in the repo.
const join = (...parts: string[]) => parts.join("");
const hex = (length: number) => "0123456789abcdef".repeat(8).slice(0, length);
const FAKES: Record<string, string> = {
  "Anthropic API key": join("sk-", "ant-", "api03-", "A1b2C3d4E5f6G7h8I9j0K1l2"),
  "OpenRouter API key": join("sk-", "or-", "v1-", hex(64)),
  "OpenAI-style API key": join("sk-", "proj-", "a".repeat(20), "B".repeat(20)),
  "GitHub token": join("gh", "p_", "a1B2".repeat(9)),
  "AWS access key id": join("AK", "IA", "ABCDEFGH23456789"),
  "Slack token": join("xo", "xb-", "1234567890-abcdefghij"),
  "Google API key": join("AI", "za", "Sy", "A".repeat(33)),
  "Stripe live key": join("sk", "_live_", "abcdefghij0123456789"),
  "private key": join("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow..."),
  JWT: join("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
};
// Same kinds, other real-world shapes.
const MORE_FAKES: [string, string][] = [
  [join("sk-", hex(32)), "OpenAI-style API key"], // DeepSeek-style: sk- and 32 lowercase hex
  [join("sk-", hex(48)), "OpenAI-style API key"],
  [join("sk-", "Ab3".repeat(12)), "OpenAI-style API key"],
  [join("sk-", "ant-", "admin01-", "Zx9".repeat(8)), "Anthropic API key"],
  [join("github_", "pat_", "11ABCDEFG0123456789abcdef"), "GitHub token"],
  [join("rk", "_live_", "abcdefghij0123456789"), "Stripe live key"],
  [join("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"), "Stripe live key"],
  [join("xo", "xp-", "1234567890-1234567890-", hex(32)), "Slack token"],
];

describe("secret scanner", () => {
  it("detects every kind", () => {
    for (const [kind, value] of Object.entries(FAKES)) {
      expect(findSecret(`here it is: ${value} thanks`, [])?.kind, kind).toBe(kind);
      expect(findSecret(value, [])?.kind, kind).toBe(kind);
    }
    for (const [value, kind] of MORE_FAKES) {
      expect(findSecret(`KEY=${value}`, [])?.kind, value).toBe(kind);
      expect(findSecret(`"${value}".`, [])?.kind, value).toBe(kind);
    }
  });

  it("detects OpenRouter and hex sk- keys", () => {
    const openrouter = FAKES["OpenRouter API key"];
    expect(findSecret(`Use the OPENROUTER key ${openrouter} for the demo`, [])?.kind).toBe("OpenRouter API key");
    expect(findSecret(join("OPENROUTER_API_KEY=sk-", "or-", "v1-", hex(32)), [])?.kind).toBe("OpenRouter API key");
    expect(findSecret(join("DEEPSEEK_API_KEY=sk-", hex(32)), [])?.kind).toBe("OpenAI-style API key");
    expect(findSecret(join("key `sk-", hex(32), "` rotated"), [])?.kind).toBe("OpenAI-style API key");
    // Too short, or part of a longer identifier: not keys.
    for (const text of [
      join("sk-", "or-", "v1-", hex(31)),
      join("sk-", hex(31)),
      join("task-", hex(40)),
      join("sk-", hex(32), "-thumbnail"),
      "sk-deadbeef-cafe-feed-face-0123456789abcdef",
    ]) {
      expect(findSecret(text, []), text).toBeNull();
    }
  });

  it("detects configured role token values", () => {
    expect(findSecret(`use ${TOKENS.developer} to log in`, [TOKENS.developer])?.kind).toBe("relay role token");
    expect(findSecret(TOKENS.developer, [TOKENS.developer])?.kind).toBe("relay role token");
    expect(findSecret(`https://relay.example.workers.dev/mcp/${TOKENS.developer}`, [TOKENS.developer])?.kind).toBe("relay role token");
    // A token the relay doesn't hold is not a role token.
    expect(findSecret(`use ${TOKENS.developer} to log in`, [TOKENS.human])).toBeNull();
  });

  it("allows ordinary 1Password references: no pattern matches them", () => {
    for (const text of [
      "op://Agent Relay/Stripe/secret-key",
      "op://vault/item/password",
      "Read it with op read op://Private/Anthropic/credential",
      "Stripe key: op://Agent Relay/Stripe/secret-key, then deploy",
      "op://Private/Anthropic API/credential",
      "op://Dev Vault/Open AI/API key/credential",
      "op://Private/Relay/developer token",
      '"op://Ops/AWS Prod/access key id".',
      "(see op://Private/GitHub/token), then deploy",
      // Item and field names shaped like key prefixes are names, not keys.
      "op://Private/sk-ant-production-api-key/credential",
      "op://Private/sk-learn-model-selection-guide/notes",
      "op://Ops/Slack/xoxb-deploy-bot-token-for-ci",
      "op://Payments/Stripe/rk_live_restricted",
      "op://Payments/Stripe/sk_live_secretkeyvalue",
      "op://Dev/GitHub/github_pat_for_ci_deploys_reminder",
      "op://Dev/OpenAI/sk-proj-loading-skeleton-placeholder-component",
    ]) {
      expect(findSecret(text, []), text).toBeNull();
    }
  });

  it("allows ordinary agent text", () => {
    for (const text of [
      // Hex colours and other CSS.
      "Use #1a2b3c and #FFAA00 for the accent; rgb(12, 34, 56); --sk-Primary-500-Contrast-Ratio-AAA-Large-Text-01: #fff",
      "styles: .sk-loading-skeleton { background: #e5e7eb }",
      // Git SHAs, short and full.
      "Deployed 3f02542a9c1b7e0d4f6a8b2c1d0e9f8a7b6c5d4e and cc50829",
      "git show 3f02542a9c1b7e0d4f6a8b2c1d0e9f8a7b6c5d4e:src/secrets.ts",
      // UUIDs.
      "session 0f8fad5b-d9cb-469f-a165-70867728950e",
      "request 0F8FAD5B-D9CB-469F-A165-70867728950E failed",
      // Kebab-case and snake_case ids, long ones included.
      "Task T2: risk-assessment-for-the-onboarding-flow-and-the-checkout-page",
      "Read the sk-learn-model-selection-guide first",
      "sk-learn-model-selection-guide-for-gradient-boosting-and-random-forests",
      "CSS class sk-loading-skeleton-placeholder-component-v2",
      "slug: sk-ant-production-api-key-rotation-runbook",
      "the xoxb-deploy-bot-token-for-ci channel",
      "setting github_pat_expiry_reminder_notification_enabled",
      "flag rk_live_restricted_mode",
      "Ship the AKIA tag and the eyJ prefix later",
      // Preview URLs with query strings.
      "https://my-app-git-feature-x-team.vercel.app/?token=abc&_vercel_share=AbCdEf0123456789AbCdEf0123456789",
      "https://deploy-preview-42--agent-relay.netlify.app/checkout?utm_source=relay&ref=sk-learn-model-selection-guide",
      "https://3f02542a.agent-relay.pages.dev/?v=2&session=0f8fad5b-d9cb-469f-a165-70867728950e",
      // A single base64 JSON segment is not a JWT.
      "data:application/json;base64,eyJhbGciOiJIUzI1NiJ9",
      "sk-or-v1 keys go in op://Dev/OpenRouter/credential",
    ]) {
      expect(findSecret(text, []), text).toBeNull();
    }
  });

  it("detects keys inside op:// references, in any segment", () => {
    for (const [kind, value] of Object.entries(FAKES)) {
      if (kind === "private key") continue; // spans lines; checked below
      for (const text of [
        `op://${value}/item/field`,
        `op://Private/${value}/field`,
        `op://Private/Item/${value}`,
        `op://Dev Vault/Open AI/${value}/section`,
        `op://note ${value}/a/b`,
        `use op://Private/Stripe/${value}`,
        `"op://Private/GitHub/${value}".`,
        `(see op://Private/GitHub/${value}), then deploy`,
      ]) {
        expect(findSecret(text, [])?.kind, text).toBe(kind);
      }
    }
    expect(findSecret(`op://${FAKES["private key"]}/a/b`, [])?.kind).toBe("private key");
    for (const [value, kind] of MORE_FAKES) expect(findSecret(`op://Private/Item/${value}`, [])?.kind, value).toBe(kind);
  });

  it("detects keys written after an op:// reference", () => {
    const openai = join("sk-", "proj-", "AbCdEf0123456789AbCdEf0123456789AbCd");
    const cases: [string, string][] = [
      [`Reads op://Dev/OpenAI/credential at boot. I removed the hardcoded ${openai} from src/lib/openai.ts`, "OpenAI-style API key"],
      [`Token is in op://Dev/GitHub/token now; old one ${FAKES["GitHub token"]} was in .env/x`, "GitHub token"],
      [`see op://Ops/AWS/secret key ${FAKES["AWS access key id"]} in config/prod`, "AWS access key id"],
      [`op://Private/Anthropic/credential and later ${FAKES["Google API key"]}`, "Google API key"],
      [`op://Private/Item/field ${FAKES["Anthropic API key"]}`, "Anthropic API key"],
      [`op://Private/Item/field,${FAKES["Anthropic API key"]}`, "Anthropic API key"],
      [`op://Private/Item/field?k=${FAKES["Anthropic API key"]}`, "Anthropic API key"],
      [`op://Private/Item/field&${FAKES["Slack token"]}`, "Slack token"],
      [`op://Private/Item/field.\t${FAKES["Anthropic API key"]}`, "Anthropic API key"],
      [`op://Private/Item/credential\n${FAKES["Stripe live key"]}`, "Stripe live key"],
      [`op://Agent Relay/OpenRouter/credential replaces ${FAKES["OpenRouter API key"]}`, "OpenRouter API key"],
      [join("op://Dev/DeepSeek/credential replaces sk-", hex(32)), "OpenAI-style API key"],
      [`op://x/y,${FAKES["Anthropic API key"]}`, "Anthropic API key"],
      [`OP://Private/Item/${FAKES["Anthropic API key"]}`, "Anthropic API key"],
    ];
    for (const [text, kind] of cases) expect(findSecret(text, [])?.kind, text).toBe(kind);
  });

  it("checks role tokens on the raw text, op:// references included", () => {
    const token = TOKENS.human;
    for (const text of [
      `op://Vault/${token}/field`,
      `op://${token}`,
      `https://x.example/a?op://=${token}`,
      `op://Private/Item/credential ${token}`,
      `op://Agent Relay/Relay/human token is ${token}`,
    ]) {
      expect(findSecret(text, [token])?.kind, text).toBe("relay role token");
    }
    expect(findSecret({ detail: { note: `op://${TOKENS.orchestrator}` } }, [TOKENS.orchestrator])).toEqual({
      kind: "relay role token",
      path: "detail.note",
    });
  });

  it("does not take kebab-case identifiers for keys", () => {
    for (const text of [
      "CSS class sk-loading-skeleton-placeholder-component-v2",
      "my_sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnop",
      "sk-proj-loading-skeleton-placeholder-component",
      "id: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJ", // uppercase but no digit
      "id: sk-abcdefghijklmnopqrstuvwxyz0123456789", // a digit but no uppercase
      "sk-learn-model-selection-guide",
      "sk-ant-production-api-key-for-the-checkout-service",
      "sk-ant-api-key-rotation-runbook-v2", // a digit but no uppercase
      "xoxb-deploy-bot-token-for-ci",
      "github_pat_expiry_reminder_notification",
      "rk_live_restricted",
      "sk_live_secretkeyvalue",
    ]) {
      expect(findSecret(text, []), text).toBeNull();
    }
    for (const text of [
      join("sk-", "Ab3".repeat(12)),
      join("key=sk-", "proj-", "abcdefghij0123456789abcdefghij01"),
      join("sk-", "svcacct-", "A".repeat(32)),
      join("sk-", "admin-", "x1".repeat(16)),
      join("sk-", hex(40)),
    ]) {
      expect(findSecret(text, [])?.kind, text).toBe("OpenAI-style API key");
    }
  });

  it("names the path of the first hit", () => {
    expect(findSecret({ links: [{ url: "https://a.example.com" }, { url: `https://b.example.com/?k=${FAKES["Google API key"]}` }] }, [])).toEqual({
      kind: "Google API key",
      path: "links[1].url",
    });
    expect(findSecret({ changes: ["ok", FAKES["Slack token"]] }, [])?.path).toBe("changes[1]");
    expect(findSecret({ note: `op://Private/Stripe/${FAKES["Stripe live key"]}` }, [])).toEqual({ kind: "Stripe live key", path: "note" });
  });

  it("finds a key at the end of a run of prefixes, in linear time", () => {
    const chain = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const cases: [string, string][] = [
      [chain("sk-ant-", 100_000), "Anthropic API key"],
      [chain("xoxb-", 100_000), "Slack token"],
      [chain("github_pat_", 100_000), "GitHub token"],
      [chain("rk_live_", 100_000), "Stripe live key"],
      [chain("_sk-", 100_000), "OpenAI-style API key"],
      [chain("sk-or-v1-", 100_000), "OpenRouter API key"],
      [` sk-${"a".repeat(100_000)}-`, "OpenAI-style API key"], // a long hex run the trailing guard rejects
      [chain(" sk-a", 100_000), "OpenAI-style API key"],
    ];
    const started = Date.now();
    for (const [text] of cases) expect(findSecret(text, [])).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(findSecret(`${chain("sk-ant-", 2000)}-${FAKES["Anthropic API key"]}`, [])?.kind).toBe("Anthropic API key");
    expect(findSecret(`${chain("sk-or-v1-", 2000)}-${FAKES["OpenRouter API key"]}`, [])?.kind).toBe("OpenRouter API key");
    expect(findSecret(`${chain("xoxb-", 2000)}-${FAKES["Slack token"]}`, [])?.kind).toBe("Slack token");
    expect(findSecret(`${chain("github_pat_", 2000)}_${join("github_", "pat_", "11ABCDEFG0123456789abcdef")}`, [])?.kind).toBe("GitHub token");
  });

  it("gives the same answer on repeated scans", () => {
    const text = `a ${FAKES["Anthropic API key"]} b ${FAKES["GitHub token"]}`;
    for (let i = 0; i < 3; i++) expect(findSecret([text, text], [])).toEqual({ kind: "Anthropic API key", path: "[0]" });
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
      { ...base, links: [{ url: `https://x.example/a?op://=${TOKENS.human}` }] },
      { ...base, body: `op://Private/Relay/${TOKENS.human}/token` },
      { ...base, body: `op://x/y,${FAKES["Anthropic API key"]}` },
      // A key inside an op:// reference, or after one, is still a key.
      { ...base, body: `use op://Private/Stripe/${FAKES["Stripe live key"]}` },
      { ...base, body: `use op://Vault/Anthropic/${FAKES["Anthropic API key"]}` },
      { ...base, body: `op://note ${FAKES["Anthropic API key"]}/a/b` },
      { ...base, body: `Reads op://Dev/OpenRouter/credential at boot; removed ${FAKES["OpenRouter API key"]} from src/lib/llm.ts` },
      { ...base, body: join("DEEPSEEK_API_KEY=sk-", hex(32)) },
    ];
    for (const input of cases) {
      const { status, body } = await callRaw("developer", "send", input);
      expect(status).toBe(400);
      expect(body.error.code).toBe("secret_detected");
      for (const value of [...Object.values(FAKES), TOKENS.human, hex(32)]) expect(JSON.stringify(body)).not.toContain(value);
    }

    // Ordinary 1Password references and ordinary text go through untouched.
    for (const text of [
      "Stripe key: op://Agent Relay/Stripe/secret-key",
      "op://vault/item/password and op://Private/sk-ant-production-api-key/credential",
      "Preview https://my-app-git-feature-x-team.vercel.app/?_vercel_share=AbCdEf0123456789AbCdEf0123456789 at 3f02542a9c1b7e0d4f6a8b2c1d0e9f8a7b6c5d4e, accent #1a2b3c",
    ]) {
      const sent = await send("developer", { ...base, body: text });
      expect(sent.message.body).toBe(text);
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

  it("rejects a role token inside an op:// reference in spike event details", async () => {
    const { status, body } = await api("developer", "POST", "/spike/events", { event: "probe", detail: { note: `op://${TOKENS.orchestrator}` } });
    expect(status).toBe(400);
    expect(body.error.code).toBe("secret_detected");
    expect(JSON.stringify(body)).not.toContain(TOKENS.orchestrator);
    const fine = await api("developer", "POST", "/spike/events", { event: "probe", detail: { note: "op://Private/Relay/developer token" } });
    expect(fine.status).toBe(200);
  });
});
