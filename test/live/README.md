# Live tests

Tests in this folder run **real Claude Code sessions** (`claude -p`) against a throwaway relay started by [`../e2e/harness.mjs`](../e2e/harness.mjs). They cost model tokens, so each one does nothing unless `RUN_LIVE=1` is set.

| File | What it checks | Run time | Cost |
|---|---|---|---|
| `mods.test.mjs` | The two Mods (`mods/relay-spike`, `mods/relay-inbox`) loaded into real sessions: hook reports, injected context, wakes, `/relay-reply`, failure handling | about 4 minutes | about $0.04 with haiku (19 sessions) |
| `rehearsal.mjs` | The whole PRD loop with three role agents (Plan B) | up to `--minutes` (45) | real; capped by `--max-invocations` (40), sonnet by default |

## Before you run

- `claude` is on `PATH` and signed in (`claude -p "hi"` answers).
- The repo's dev dependencies are installed (`wrangler` starts the relay).
- With an HTTP(S) proxy configured, set `NO_PROXY=127.0.0.1,localhost`, so the test process and the sessions reach the local relay directly.
- Function hooks are early access. If a session prints, or its debug log has, `hooks module relay-… not loaded: … rollout switch`, the switch is off on this machine and these tests cannot pass. A failing test prints the debug log's load lines.

## Run the Mod checks

```sh
RUN_LIVE=1 NO_PROXY=127.0.0.1,localhost node --test test/live/mods.test.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `RUN_LIVE` | unset | `1` runs the tests; anything else skips them all (no relay, no sessions) |
| `LIVE_MODEL` | `haiku` | the `--model` given to every session |
| `LIVE_KEEP` | unset | `1` keeps the temp folder with each session's `--debug-file` log and MCP config |

Near the end of the output, a line gives the number of sessions and what `claude` reported they cost, for example `# live Mod checks: 19 claude sessions, $0.0370 as reported by claude (haiku)`. Fourteen of those sessions prompt the model. The other five are Mod commands (`/relay-spike`, `/relay-reply`), which cost nothing.

Nothing is installed, and no settings file is changed. Each session:

- loads a Mod from its folder with `--plugin-dir mods/<name>`;
- gets the Mod's options from `--settings '{"pluginConfigs": {"<name>": {"options": {...}}}}'`;
- reads no user or local settings (`--setting-sources project`, with an empty temp folder as its working directory) and only the MCP servers the test passes (`--strict-mcp-config`).

The relay MCP server is given as `--mcp-config` with the role's `Authorization: Bearer` header, plus `--allowedTools mcp__relay__*`. Variables that carry a parent Claude Code session's identity (`CLAUDE_CODE_SESSION_ID` and the like) are removed from the children's environment.

Each session is started with `--output-format stream-json --verbose`. That keeps every turn's result: with `--output-format json`, a second turn started by a wake replaces the first turn's `result`. It also keeps the Mods' status line, which a headless session reports as `{"type":"system","subtype":"ui_status","plugin":"relay-inbox","text":"Relay · 1 unread · …"}`. Long-lived sessions use `--input-format stream-json` with stdin left open, the way the SDK and the desktop app host a session. A session hosted that way sits idle between turns, so a Mod can wake it.

## What `mods.test.mjs` covers

**relay-spike**

- The hook report reaches `/spike/events`: `session.start` (with the marker nonce), `prompt.submit`, `turn.start`, `context.injected`, `tool.call` (the tool name only), `turn.complete` and `session.end`. Every record carries the token's role. No record holds the prompt text, the file contents, the file name or the token.
- The model quotes `relay-spike marker: <nonce>`, and the nonce matches the one the relay recorded.
- Wakes:
  - A wake queued before the session starts is consumed (`wake.submitted`, then `wake.turn_started`) and runs as a second turn.
  - An idle long-lived session is woken within about 20 s of a wake being queued.
  - A wake that arrives while a turn runs is consumed and logged as `wake.skipped_busy`, and no second turn runs.
- When the relay is down or the token is rejected, the turn still completes (exit 0), and `/relay-spike` says what is wrong.

**relay-inbox**

- An unread message reaches the model with the next prompt. The relay then marks it read, and the poll records the session as the role's presence.
- With the relay MCP server also connected, the `inbox` tool does not list an injected message again.
- `/relay-reply` sends a `status` reply, with `reply_to`, to the newest message's sender: the orchestrator, then the human.
- Auto-wake: an idle long-lived session starts a turn by itself when a message arrives, and the role answers over MCP.
- A message that arrives during a one-shot `-p` turn stays unread for the next session.
- When the relay is down, the token is rejected or the relay never answers, the turn still completes. The status line reads `unreachable (…)`, `token rejected (401)` or `timeout: no answer within 8s`. A relay that never answers keeps a `-p` process alive about 30 s after its answer, because `$.http.fetch` cannot be aborted.
- Tests marked `todo` reproduce known defects. They run and print why they fail, but they don't fail the suite:
  - A message marked read alongside an injected batch never reaches the model.
  - Messages injected while the kill switch is on are gone from the inbox once it is cleared.
  - A `/relay-reply` to a nudge doesn't count as activity on the task, so the task still escalates to the human.

  Once a defect is fixed, its test passes. Then drop its `todo`.

## What this cannot check headless

- **The band above the prompt** (and its Read and Reply buttons) is drawn only in the terminal and the desktop app; a `-p` session draws no UI.
- **A wake in an interactive terminal session.** The checks use a long-lived headless session (stream-json input) instead.
- **Auto-wake in a one-shot `-p` run.** The session ends straight after its turn, and the inbox Mod waits 10 s after start before it wakes anyone.
- **Project threads, the desktop app, the web and the phone app**, the surfaces `docs/SPIKE.md` is about. Run those by hand with that runbook.
