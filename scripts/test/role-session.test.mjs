// Fake-run tests for scripts/role-session.sh: a fake `claude` on PATH records its argv, environment, working
// directory and umask, and tries what an agent's Bash tool could (`op read` of the human token); a fake `op`
// answers only while a 1Password session or service-account token is set. No network, no real claude or op.
//
//   node --test scripts/test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts", "role-session.sh");
const FILES = [".relay-inbox.json", ".relay-mcp.json", ".relay-instructions.md"];

// Obvious fake values (32+ URL-safe chars where a token must pass the script's check).
const DEV = "fake-developer-token-0123456789abcdefghij";
const DEV_FROM_OP = "fake-op-developer-token-0123456789abcdefgh";
const HUMAN_FROM_OP = "fake-op-human-token-0123456789abcdefghijk";
const OTHER_TOKENS = {
  RELAY_TOKEN: "fake-relay-token-0123456789abcdefghijklmn",
  ORCHESTRATOR_TOKEN: "fake-orchestrator-token-0123456789abcdefg",
  CREATIVE_DIRECTOR_TOKEN: "fake-creative-director-token-0123456789ab",
  HUMAN_TOKEN: "fake-human-token-0123456789abcdefghijklmn",
};
const CREDENTIALS = {
  OP_SESSION_my: "fake-op-session-my",
  OP_SESSION: "fake-op-session",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_fake-service-account-token",
  OP_CONNECT_TOKEN: "fake-op-connect-token",
  OP_CONNECT_HOST: "https://op-connect.example",
  CLOUDFLARE_API_TOKEN: "fake-cloudflare-api-token",
  CLOUDFLARE_API_KEY: "fake-cloudflare-api-key",
  CF_API_TOKEN: "fake-cf-api-token",
  CF_API_KEY: "fake-cf-api-key",
};

let root;
let bin;
let n = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), "role-session-test-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env bash
out="\${FAKE_CLAUDE_OUT:?}"
printf 'cwd=%s\\numask=%s\\n' "$(pwd -P)" "$(umask)" >"$out.meta"
printf '%s\\0' "$@" >"$out.argv"
env -0 >"$out.env"
# What a Bash tool call in the session could try: the human token through 1Password.
if op read --no-newline 'op://Agent Relay/Human token/password' >"$out.op" 2>&1; then echo reached >"$out.op-ok"; fi
echo "fake claude ran"
`,
  );
  writeFileSync(
    join(bin, "op"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"\${FAKE_OP_LOG:-/dev/null}"
[[ -n "\${OP_SERVICE_ACCOUNT_TOKEN:-}\${OP_SESSION_my:-}" ]] || { echo "[ERROR] not signed in" >&2; exit 1; }
case "$*" in
  "read --no-newline op://Agent Relay/Developer token/password") printf '%s' '${DEV_FROM_OP}' ;;
  "read --no-newline op://Agent Relay/Human token/password") printf '%s' '${HUMAN_FROM_OP}' ;;
  *) echo "[ERROR] no such item" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "op"), 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

/** A fresh case directory with a home, a role directory (with CLAUDE.md) and the fake claude's output prefix. */
function fresh() {
  const dir = join(root, `case-${++n}`);
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "CLAUDE.md"), "# Developer Project\n");
  return { dir, home, work, out: join(dir, "claude"), opLog: join(dir, "op.log") };
}

/** Runs the script under bash with only the given environment (plus PATH and HOME), at the given umask. */
function run(c, args, env = {}, { umask = "022" } = {}) {
  const fullEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: c.home,
    RELAY_URL: "https://relay.example.workers.dev",
    FAKE_CLAUDE_OUT: c.out,
    FAKE_OP_LOG: c.opLog,
    ...env,
  };
  for (const [key, value] of Object.entries(fullEnv)) if (value === undefined) delete fullEnv[key];
  const result = spawnSync("bash", ["-c", `umask ${umask}; exec bash "$0" "$@"`, SCRIPT, ...args], {
    env: fullEnv,
    encoding: "utf8",
    cwd: c.dir,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function claudeRun(c) {
  assert.ok(existsSync(`${c.out}.argv`), "the fake claude ran");
  const argv = readFileSync(`${c.out}.argv`, "utf8").split("\0").slice(0, -1);
  const env = Object.fromEntries(
    readFileSync(`${c.out}.env`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const meta = Object.fromEntries(
    readFileSync(`${c.out}.meta`, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  return { argv, env, meta, opReached: existsSync(`${c.out}.op-ok`) };
}

const mode = (path) => (statSync(path).mode & 0o777).toString(8);
const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const listing = (dir) => readdirSync(dir).sort();

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

describe("role-session.sh", () => {
  it("parses (bash -n), as does put-secrets.sh", () => {
    for (const script of [SCRIPT, join(REPO, "scripts", "put-secrets.sh")]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
  });

  it("starts claude with no relay token, 1Password credential or Cloudflare token in its environment", () => {
    const c = fresh();
    const r = run(c, ["developer", "--dir", c.work, "--no-check"], {
      DEVELOPER_TOKEN: DEV,
      ...OTHER_TOKENS,
      ...CREDENTIALS,
      OP_REF_DEVELOPER: "op://Agent Relay/Developer token/password",
      GITHUB_TOKEN: "fake-github-token-kept",
      KEEP_ME: "1",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "fake claude ran\n");
    const { argv, env, opReached } = claudeRun(c);
    const removed = ["DEVELOPER_TOKEN", ...Object.keys(OTHER_TOKENS), ...Object.keys(CREDENTIALS)];
    for (const name of removed) assert.equal(env[name], undefined, `${name} reached claude`);
    assert.deepEqual(Object.keys(env).filter((name) => name.startsWith("OP_")), [], "no OP_* variable reaches claude");
    // Only those: the session keeps the rest of the caller's environment.
    assert.equal(env.KEEP_ME, "1");
    assert.equal(env.GITHUB_TOKEN, "fake-github-token-kept");
    assert.equal(env.RELAY_URL, "https://relay.example.workers.dev");
    assert.equal(env.HOME, c.home);
    assert.equal(opReached, false, "an agent's `op read` of the human token must fail");
    // The token is never an argument and never printed.
    const values = [DEV, ...Object.values(OTHER_TOKENS)];
    for (const value of values) {
      assert.ok(!argv.some((arg) => arg.includes(value)), "a token is in claude's argv");
      assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value), "a token was printed");
    }
  });

  it("reads the token with op (e.g. a service account) and leaves the session no way back into 1Password", () => {
    const c = fresh();
    const r = run(c, ["developer", "--dir", c.work, "--no-check"], {
      XDG_STATE_HOME: join(c.dir, "state"),
      OP_SERVICE_ACCOUNT_TOKEN: CREDENTIALS.OP_SERVICE_ACCOUNT_TOKEN,
    });
    assert.equal(r.status, 0, r.stderr);
    // The script's own read, then the session's attempt at the human token (which fails, below).
    assert.deepEqual(readFileSync(c.opLog, "utf8").trim().split("\n"), [
      "read --no-newline op://Agent Relay/Developer token/password",
      "read --no-newline op://Agent Relay/Human token/password",
    ]);
    const state = join(c.dir, "state", "agent-relay", "developer");
    assert.match(readFileSync(join(state, ".relay-mcp.json"), "utf8"), new RegExp(`"Bearer ${DEV_FROM_OP}"`));
    const { argv, env, opReached } = claudeRun(c);
    assert.equal(env.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.equal(opReached, false, "the service-account token must not reach the session");
    assert.match(readFileSync(`${c.out}.op`, "utf8"), /not signed in/);
    assert.ok(!argv.some((arg) => arg.includes(DEV_FROM_OP)));
    assert.ok(!(r.stdout + r.stderr).includes(DEV_FROM_OP));
  });

  it("writes the token files to the state directory (dir 700, files 600) and passes their absolute paths", () => {
    const c = fresh();
    const xdg = join(c.dir, "xdg");
    const r = run(c, ["developer", "--dir", c.work, "--no-check", "--model", "haiku"], { DEVELOPER_TOKEN: DEV, XDG_STATE_HOME: xdg });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const state = join(xdg, "agent-relay", "developer");
    assert.equal(mode(join(xdg, "agent-relay")), "700");
    assert.equal(mode(state), "700");
    assert.deepEqual(listing(state), FILES.slice().sort(), "only the three files, no temp files left");
    for (const file of FILES) assert.equal(mode(join(state, file)), "600", file);

    const settings = JSON.parse(readFileSync(join(state, ".relay-inbox.json"), "utf8"));
    assert.deepEqual(settings, {
      pluginConfigs: { "relay-inbox": { options: { relay_url: "https://relay.example.workers.dev", role_token: DEV, auto_wake: true } } },
    });
    const mcp = JSON.parse(readFileSync(join(state, ".relay-mcp.json"), "utf8"));
    assert.deepEqual(mcp, {
      mcpServers: {
        relay: { type: "http", url: "https://relay.example.workers.dev/mcp", headers: { Authorization: `Bearer ${DEV}` } },
      },
    });
    const instructions = readFileSync(join(state, ".relay-instructions.md"), "utf8");
    const protocol = readFileSync(join(REPO, "protocol", "PROTOCOL.md"), "utf8");
    const addendum = readFileSync(join(REPO, "protocol", "roles", "developer.md"), "utf8");
    assert.equal(instructions, `${protocol}\n${addendum}`);

    const { argv, meta } = claudeRun(c);
    assert.deepEqual(argv, [
      "--plugin-dir",
      join(REPO, "mods", "relay-inbox"),
      "--settings",
      join(state, ".relay-inbox.json"),
      "--mcp-config",
      join(state, ".relay-mcp.json"),
      "--append-system-prompt-file",
      join(state, ".relay-instructions.md"),
      "--name",
      "relay developer",
      "--model",
      "haiku",
      "Session started by scripts/role-session.sh: check your relay inbox and act per the relay protocol.",
    ]);
    assert.equal(meta.cwd, c.work, "claude runs in --dir");
    assert.equal(meta.umask, "0022", "the session gets the caller's umask back");
  });

  it("defaults to ~/.local/state/agent-relay/<role> and ignores a relative XDG_STATE_HOME", () => {
    const c = fresh();
    const r = run(c, ["creative-director", "--dir", c.work, "--no-check", "--no-prompt", "--", "--remote-control"], {
      CREATIVE_DIRECTOR_TOKEN: OTHER_TOKENS.CREATIVE_DIRECTOR_TOKEN,
      XDG_STATE_HOME: "relative/state",
    });
    assert.equal(r.status, 0, r.stderr);
    const state = join(c.home, ".local", "state", "agent-relay", "creative-director");
    assert.deepEqual(listing(state), FILES.slice().sort());
    assert.ok(!existsSync(join(c.dir, "relative")), "nothing under the relative path");
    const { argv } = claudeRun(c);
    assert.equal(argAfter(argv, "--settings"), join(state, ".relay-inbox.json"));
    assert.ok(!argv.some((arg) => arg.startsWith("Session started")), "--no-prompt sends no first prompt");
    assert.equal(argv.at(-1), "--remote-control");
  });

  for (const dryRun of [false, true]) {
    it(`writes nothing into --dir, a git repository that doesn't ignore .relay-* (${dryRun ? "dry run" : "run"})`, () => {
      const c = fresh();
      writeFileSync(join(c.work, ".gitignore"), "node_modules\n");
      git(c.work, "init", "-q", ".");
      git(c.work, "add", "-A");
      git(c.work, "commit", "-q", "-m", "init");
      const beforeRun = listing(c.work);
      const r = run(c, ["developer", "--dir", c.work, "--no-check", ...(dryRun ? ["--dry-run"] : [])], {
        DEVELOPER_TOKEN: DEV,
        XDG_STATE_HOME: join(c.dir, "state"),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(listing(c.work), beforeRun);
      git(c.work, "add", "-A");
      assert.equal(git(c.work, "status", "--porcelain", "--ignored"), "", "git add -A stages nothing");
      if (dryRun) {
        const state = join(c.dir, "state", "agent-relay", "developer");
        assert.ok(!existsSync(`${c.out}.argv`), "a dry run doesn't start claude");
        assert.match(r.stdout, new RegExp(`wrote \\(mode 600\\) in ${state}: \\.relay-inbox\\.json \\.relay-mcp\\.json \\.relay-instructions\\.md`));
        assert.ok(r.stdout.includes(`--settings ${join(state, ".relay-inbox.json")}`));
        assert.ok(r.stdout.includes("token: from DEVELOPER_TOKEN (not shown)"));
        assert.ok(!r.stdout.includes(DEV) && !r.stderr.includes(DEV));
      }
    });
  }

  it("removes token files an earlier version left in --dir, with a warning", () => {
    const c = fresh();
    for (const file of FILES) writeFileSync(join(c.work, file), `{"old": "${DEV}"}\n`, { mode: 0o644 });
    const r = run(c, ["developer", "--dir", c.work, "--no-check"], { DEVELOPER_TOKEN: DEV, XDG_STATE_HOME: join(c.dir, "state") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listing(c.work), ["CLAUDE.md"]);
    for (const file of FILES) assert.ok(r.stderr.includes(`removed ${join(c.work, file)}`), `warns about ${file}`);
    assert.ok(!r.stderr.includes(DEV));
  });

  it("tightens a state directory and files left with loose modes", () => {
    const c = fresh();
    const xdg = join(c.dir, "state");
    const state = join(xdg, "agent-relay", "developer");
    mkdirSync(state, { recursive: true, mode: 0o755 });
    chmodSync(join(xdg, "agent-relay"), 0o755);
    chmodSync(state, 0o755);
    writeFileSync(join(state, ".relay-inbox.json"), "{}\n", { mode: 0o644 });
    const r = run(c, ["developer", "--dir", c.work, "--no-check", "--dry-run"], { DEVELOPER_TOKEN: DEV, XDG_STATE_HOME: xdg });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(join(xdg, "agent-relay")), "700");
    assert.equal(mode(state), "700");
    for (const file of FILES) assert.equal(mode(join(state, file)), "600", file);
    assert.deepEqual(listing(state), FILES.slice().sort());
  });

  it("refuses a state directory inside a git work tree that doesn't ignore the files", () => {
    const c = fresh();
    const repo = join(c.dir, "dotfiles");
    mkdirSync(repo);
    git(repo, "init", "-q", ".");
    const r = run(c, ["developer", "--dir", c.work, "--no-check"], { DEVELOPER_TOKEN: DEV, XDG_STATE_HOME: join(repo, "state") });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inside a git working tree that doesn't ignore \.relay-inbox\.json: set XDG_STATE_HOME/);
    for (const file of FILES) assert.ok(!existsSync(join(repo, "state", "agent-relay", "developer", file)), `${file} written`);
    assert.ok(!existsSync(`${c.out}.argv`));
  });

  it("refuses the human role and an unknown argument, and starts nothing", () => {
    const c = fresh();
    const human = run(c, ["human", "--no-check"], { HUMAN_TOKEN: OTHER_TOKENS.HUMAN_TOKEN });
    assert.equal(human.status, 1);
    assert.match(human.stderr, /not run as a role session/);
    const unknown = run(c, ["developer", "--bogus"], { DEVELOPER_TOKEN: DEV });
    assert.equal(unknown.status, 2);
    assert.ok(!existsSync(`${c.out}.argv`));
    assert.ok(!existsSync(join(c.home, ".local")), "no state written");
  });

  it("documents the state directory and the scrubbed environment in --help", () => {
    const c = fresh();
    const r = run(c, ["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /XDG_STATE_HOME/);
    assert.match(r.stdout, /OP_\*/);
    assert.match(r.stdout, /CLOUDFLARE_API_TOKEN/);
  });
});
