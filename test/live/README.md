# Live tests

Tests in this folder run **real Claude Code sessions** (`claude -p`) against a throwaway relay started by [`../e2e/harness.mjs`](../e2e/harness.mjs) (a fresh `wrangler dev` with its own port, storage and random tokens, stopped at the end). They cost model tokens, so each one does nothing unless `RUN_LIVE=1` is set.

| File | What it checks | Run time | Cost |
|---|---|---|---|
| `mods.test.mjs` | The two Mods (`mods/relay-spike`, `mods/relay-inbox`) loaded into real sessions: hook reports, injected context, wakes, `/relay-reply`, halts, failure handling | about 5 minutes | about $0.05 with haiku (20 tests, about 24 sessions) |
| `rehearsal.mjs` | The whole PRD loop with three role agents (Plan B): kickoff, plan approval, design, build, review, ship, final sign-off | until the build ships (3 to 6 minutes for the sample brief), or `--minutes` (45) | real: $3 to $4 with sonnet for the sample brief; capped by `--max-invocations` (40) |

## Before you run

- `claude` is on `PATH` and signed in (`claude -p "hi"` answers).
- The repo's dev dependencies are installed (`npm ci`; `wrangler` starts the relay).
- With an HTTP(S) proxy configured, set `NO_PROXY=127.0.0.1,localhost`, so the test process and the sessions reach the local relay directly.
- Function hooks are early access. If a session prints, or its debug log has, `hooks module relay-… not loaded: … rollout switch`, the switch is off on this machine and the Mod tests cannot pass. A failing test prints the debug log's load lines.

## Run the Mod checks

```sh
RUN_LIVE=1 NO_PROXY=127.0.0.1,localhost node --test test/live/mods.test.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `RUN_LIVE` | unset | `1` runs the tests; anything else skips them all (no relay, no sessions) |
| `LIVE_MODEL` | `haiku` | the `--model` given to every session |
| `LIVE_KEEP` | unset | `1` keeps the temp folder with each session's `--debug-file` log and MCP config |

Output is the `node --test` report. Near the end, a line gives the number of sessions and what `claude` reported they cost, for example `# live Mod checks: 24 claude sessions, $0.0455 as reported by claude (haiku)`. Some of those sessions only run a Mod command (`/relay-spike`, `/relay-reply`), which costs nothing.

Nothing is installed, and no settings file is changed. Each session:

- loads a Mod from its folder with `--plugin-dir mods/<name>`;
- gets the Mod's options from `--settings '{"pluginConfigs": {"<name>": {"options": {...}}}}'`;
- reads no user or local settings (`--setting-sources project`, with an empty temp folder as its working directory) and only the MCP servers the test passes (`--strict-mcp-config`).

The relay MCP server is given as `--mcp-config` with the role's `Authorization: Bearer` header, plus `--allowedTools mcp__relay__*`. That is the same arrangement [`scripts/role-session.sh`](../../scripts/role-session.sh) sets up for a real role session. Variables that carry a parent Claude Code session's identity (`CLAUDE_CODE_SESSION_ID` and the like) are removed from the children's environment.

Each session is started with `--output-format stream-json --verbose`. That keeps every turn's result: with `--output-format json`, a second turn started by a wake replaces the first turn's `result`. It also keeps the Mods' status line, which a headless session reports as `{"type":"system","subtype":"ui_status","plugin":"relay-inbox","text":"Relay · 1 unread · …"}`. Long-lived sessions use `--input-format stream-json` with stdin left open, the way the SDK and the desktop app host a session. A session hosted that way sits idle between turns, so a Mod can wake it.

## What `mods.test.mjs` covers

**relay-spike**

- The hook report reaches `/spike/events`: `session.start` (with the marker nonce and a fingerprint of the directory), `prompt.submit`, `turn.start`, `prompt.context` (the context block names, and SHA-256 prefix and length of the attached Project block and the directory), `context.injected`, `tool.call` (the tool name only), `turn.complete` and `session.end`. Every record carries the token's role. No record holds the prompt text, the file contents, the file name or the token.
- The model quotes `relay-spike marker: <nonce>`, and the nonce is the one derived from the session id.
- Wakes:
  - A wake queued for a session before it starts is consumed (`wake.submitted`, then `wake.turn_started`) and runs as a second turn.
  - An idle long-lived session is woken within about 20 s of a wake being queued.
  - A wake that arrives while a turn runs is deferred (`wake.deferred`) and submitted once that turn completes.
- When the relay is down or the token is rejected, the turn still completes (exit 0), and `/relay-spike` says what is wrong.

**relay-inbox**

- The next prompt carries the unread messages, and exactly those are marked read on the relay. The poll records the session as the role's presence, and the status line counts the unread messages.
- With the relay MCP server also connected, the `inbox` tool does not list an injected message again.
- A message that arrives after the last poll still rides the next prompt: the prompt makes its own read.
- A message that arrives during a one-shot `-p` turn stays unread for the next session.
- While the kill switch is on, a prompt carries no relay messages, the status line shows the halt, and the messages are still unread once it is cleared.
- `/relay-reply` sends a `status` reply, with `reply_to`, to the newest message's sender: the orchestrator, then the human. A reply to a nudge names the nudged task, so it counts as activity and the task doesn't escalate to the human.
- Auto-wake: an idle long-lived session starts a turn by itself when a message arrives, and the role answers over MCP.
- When the relay is down, the token is rejected or the relay never answers, the turn still completes. The status line reads `unreachable (…)`, `token rejected (401)` or `timeout: no answer within 3s`. A relay that never answers keeps a `-p` process alive about 30 s after its answer, because `$.http.fetch` cannot be aborted.

## Run the rehearsal

```sh
RUN_LIVE=1 NO_PROXY=127.0.0.1,localhost node test/live/rehearsal.mjs [--model sonnet] [--minutes 45] [--max-invocations 40] [--nudge 4] [--out <dir>]
```

| Option | Default | Meaning |
|---|---|---|
| `--model` | `sonnet` | the model every role session runs |
| `--minutes` | `45` | stop after this long, shipped or not |
| `--max-invocations` | `40` | most `claude -p` runs across all roles (the cost cap) |
| `--nudge` | `4` | `NUDGE_AFTER_MINUTES` for the throwaway relay, so nudges show up within a short run |
| `--out` | a new `agent-relay-rehearsal-<time>` folder in the system temp dir | where the report, the app and the logs go |

What it does: it starts a relay and a static preview server for a shared workspace, then creates a build with a small sample brief (a "Split the bill" calculator) as James. Each role (`orchestrator`, `creative-director`, `developer`) runs as `claude -p` in that workspace, with the relay as its only MCP server, `protocol/PROTOCOL.md` plus its addendum appended to the system prompt, and `--resume`, so every wake continues one conversation per role. As `scripts/role-session.sh` does, it starts them without the relay token variables, any `OP_*` variable or the Cloudflare API token variables in their environment. The driver stands in for relay-inbox's wake path: every 4 s it peeks each role's inbox and wakes a role that has unread mail with the Mod's exact wake prompt. It also stands in for James: it approves every gate (escalations get one more round) and answers every question with "use your judgement". Everything the agents do goes through the relay.

It prints one line per event (`wake developer #2: …`, `done developer #2 (exit 0, 7 turns, $0.31): …`, `James decided plan_approval G1: approved`, `build shipped`), and leaves in `--out`:

- `report.md`: status, minutes, model, cost, human touchpoints, agent messages, escalations, nudges and stalled tasks; wakes and turns per role; the task table; the touchpoints; the last 50 messages.
- `report.json`: the same numbers, plus the final ledger, the touchpoints and each role's session state.
- `ws/`: the workspace the agents wrote, with the spec under `design/` and the app under `app/`.
- `logs/`: each role's instructions and MCP config, and each `claude -p` run's JSON output (`<role>.<n>.json`). The MCP configs hold the throwaway relay's tokens, which die with it.

What to look at: did the build ship; were there exactly two human touchpoints (plan approval and final sign-off); did any task stall or escalate; did each role do its own part (the creative director finishes its design task with a `handoff` naming the build task as `next_task_id`, the developer sends review requests to the reviewer, the orchestrator requests final sign-off when the relay says every task is closed).

## What this cannot check headless

- **The band above the prompt** (and its Read and Reply buttons) is drawn only in the terminal and the desktop app; a `-p` session draws no UI.
- **A wake in an interactive terminal session.** The checks use a long-lived headless session (stream-json input) instead.
- **Auto-wake in a one-shot `-p` run.** The session ends straight after its turn, and the inbox Mod waits 10 s after start before it wakes anyone.
- **Project threads, the desktop app, the web and the phone app**, the surfaces [`docs/SPIKE.md`](../../docs/SPIKE.md) is about. Run those by hand with that runbook.
