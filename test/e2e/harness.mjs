// Starts a throwaway relay with `wrangler dev` for end-to-end tests.
//
//   const relay = await startRelay({ vars: { NUDGE_AFTER_MINUTES: "0.05" } });
//   relay.url, relay.tokens.developer, relay.mcpUrl("developer"), await relay.call("human", "build_list", {})
//   await relay.stop();
//
// Each relay gets its own port, its own persistence directory and fresh random
// tokens loaded through --env-file, so a local .dev.vars never leaks in.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRANGLER = join(REPO, "node_modules", ".bin", "wrangler");

export const ROLES = ["orchestrator", "creative-director", "developer", "human"];
const TOKEN_VARS = {
  orchestrator: "ORCHESTRATOR_TOKEN",
  "creative-director": "CREATIVE_DIRECTOR_TOKEN",
  developer: "DEVELOPER_TOKEN",
  human: "HUMAN_TOKEN",
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startRelay({ vars = {}, tokens: tokenOverrides = {}, timeoutMs = 60_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-e2e-"));
  const tokens = Object.fromEntries(
    ROLES.map((role) => [role, tokenOverrides[role] ?? `e2e-${role}-${randomBytes(24).toString("base64url")}`]),
  );
  const env = { ...vars };
  for (const role of ROLES) env[TOKEN_VARS[role]] = tokens[role];
  const envFile = join(dir, "test.env");
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");

  const port = await freePort();
  const inspectorPort = await freePort();
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--inspector-port", String(inspectorPort),
      "--persist-to", join(dir, "state"),
      "--env-file", envFile,
      "--show-interactive-dev-session=false",
      "--log-level", "warn",
    ],
    { cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`relay did not become healthy in ${timeoutMs} ms:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  /** POST /api/call/:tool as `role`; resolves to the parsed envelope plus the HTTP status. */
  const call = async (role, tool, input = {}) => {
    const res = await fetch(`${url}/api/call/${tool}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[role]}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: res.status, ...(await res.json()) };
  };

  return {
    url,
    port,
    tokens,
    log: () => log,
    mcpUrl: (role, { pathToken = false } = {}) => (pathToken ? `${url}/mcp/${tokens[role]}` : `${url}/mcp`),
    call,
    stop,
  };
}
