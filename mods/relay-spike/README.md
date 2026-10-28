# relay-spike

A Claude Code Mod that answers Agent Relay's first milestone (see [`docs/PRD.md`](../../docs/PRD.md)): do Mod hooks fire in a given kind of session (a Project thread, the desktop Code tab, a terminal), which ones, does context a Mod injects reach the model, can anything start a turn in an idle session, and can a Mod tell one Project's threads from another's?

It reports what it sees to the relay's spike endpoints (`POST /spike/events`, `GET /spike/wake`, [`docs/DESIGN.md`](../../docs/DESIGN.md) section 11). The way to run the spike end to end is in `docs/SPIKE.md`.

## What it does

- **Hook report.** Every occurrence of the hooked events becomes one record `{event, ts, session_id, surface, agent_id, detail}` posted to `/spike/events`. Hooked events: `session.start`, `session.end`, `session.receive`, `session.attach`, `session.detach`, `session.compact`, `turn.start`, `turn.complete`, `prompt.submit`, `prompt.context`, `prompt.compose`, `tool.call`, `agent.spawn`, `command.run`, and `ui.render` of the band above the prompt (once per surface). Every hook passes the event on unchanged; a failing POST never affects one.
- **Which Project a thread is.** Each `prompt.context` record (the context blocks a conversation's first message carries) lists the blocks' names (`claudeMd`, `userEmail`, `attachedProject`, `currentDate`, ...) and fingerprints, never the text: the SHA-256 prefix and length of the `attachedProject` block's text (`null` when there is none) and of the session's directory (`$.session.cwd()`). `session.start` carries the directory's fingerprint too. Two threads of the same Project show the same `attached_project` fingerprint and two Projects different ones, which tells whether a Mod could pick the role per thread.
- **Injection probe.** Each typed prompt carries one extra line of context the model reads and the person never sees: `relay-spike marker: <nonce>`. The nonce is derived from the session id, so it stays the same when the Mod reloads (a `/config` change, a late load) and changes only with a new conversation (`/clear`). Each time it is added, a `context.injected` record is posted with the nonce. Ask the model "What is the relay-spike marker?": if it answers the nonce shown by `/relay-spike` (and in the `session.start` record), injected context reaches the model in that kind of session.
- **Wake probe.** Every `poll_seconds` the Mod asks `GET /spike/wake?session_id=<this session>`, which returns the wake requests queued for this token's role that name this session or no session. For each one, when no turn is running, it submits the wake's text as a prompt and records `wake.submitted`, then `wake.turn_started` once the turn starts (or `wake.failed` with the reason). A wake that arrives while a turn runs is kept (`wake.deferred`) and submitted as soon as that turn completes, oldest first, its `wake.submitted` record saying how long it waited (`deferred_s`); in a `claude -p` run it becomes the run's next turn. One whose turn has not started after two minutes is recorded as `wake.not_started`.
- **Heartbeat.** Every five minutes a `spike.heartbeat` record carries the uptime, the deferred wakes and the count of every event seen, so the log shows whether the Mod keeps running while a session sits idle.
- **`/relay-spike`.** Shows the marker nonce, whether the relay answers `/health`, whether the token was accepted, how many records were sent, queued, dropped or refused, the deferred wakes, the last error, and how often each event fired since the Mod loaded.

To ask for a wake, as the human, using `human_auth` and `RELAY_URL` from [`docs/SETUP.md`](../../docs/SETUP.md) section 3 (the token is read by `op read` and piped in, never put on a command line). Always name the `role` whose session should run it, and ideally that session's id: a wake without `session_id` runs in the first session of that role that polls, which may be another one, such as a headless role run.

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' \
  -d '{"role": "developer", "session_id": "<session id from /relay-spike or the records>", "text": "Reply with the word awake."}' \
  "$RELAY_URL/spike/wake"
```

Read the records back with `GET /spike/events` (human token), or on the relay's `/spike` page.

## Install

Install it only where you are testing: a session that loads it takes every untargeted wake for its role, and an extra turn in a headless role run replaces that run's result. Never at user scope next to Plan B role sessions or a rehearsal. For one session, run it from its folder (`claude --plugin-dir mods/relay-spike`); to keep it in one directory, at the prompt of a terminal session there:

```
/plugin install relay-spike --marketplace jd-green/agent-relay
```

Answer `y` to add the marketplace, choose the local scope, then fill in the options screen. From a shell: `claude plugin install relay-spike --marketplace jd-green/agent-relay --scope local`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jd-green/agent-relay`, then Add plugin. A private repository installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com.

Its options, like every plugin's, are stored once per user and machine whatever the scope: the spike reports as one role per machine.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | string, required | | Base URL of the relay Worker, e.g. `https://agent-relay.<account>.workers.dev`. Must be `https`; plain `http://` is accepted only for `localhost` and `127.0.0.1`. |
| `role_token` | string, required, sensitive | | Any role's bearer token; spike events accept every role, and wakes are delivered to that role. Kept in secure storage, not in settings.json. |
| `poll_seconds` | number | `30` | How often to ask for wake requests; at least 15. |

Change the non-secret values later in `/config`, or any of them with `/plugin configure relay-spike@agent-relay` in a session, or from a shell with `echo '{"poll_seconds": 15}' | claude plugin configure relay-spike@agent-relay --values-stdin`. `claude plugin configure` needs the full id (`relay-spike@agent-relay`) and without `--values-stdin` only lists the options and which are unset. With `--plugin-dir` the options come from `--settings`, under `pluginConfigs["relay-spike"].options`. An unusable `relay_url` (not https, or http to another host) stops the Mod from loading, with that reason.

## Privacy

The records carry event names, timestamps, the session id, the surface (`terminal`, `desktop`, ...), subagent ids, and small metadata only: lengths, tool and command names, origins and reasons, the Claude Code version, the marker nonce, context block names, SHA-256 prefixes and lengths of the attached Project's text and of the directory, and the values of `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_REMOTE`. They never carry prompt text, model answers, tool inputs or outputs, file contents or paths, the Project's text, wake text (only its length) or the token. The token is sent only to `relay_url`, in the `Authorization` header.

## Behaviour worth knowing

- Records are buffered and posted in batches of up to 20 every 5 seconds. After a failed POST the Mod waits 10 seconds, doubling up to 5 minutes; it keeps up to 500 records meanwhile, dropping the oldest. A record the relay refuses as invalid is dropped alone.
- At most 50 records per event name are posted per load; later occurrences are only counted (in the heartbeat and `/relay-spike`), so a busy session cannot flood the relay. Heartbeats and `wake.*` records are exempt, so an overnight run keeps reporting. Counts start again when the Mod reloads.
- A wake is a plugin prompt: the transcript shows it as sent by the relay-spike plugin. One submitted at a poll (from the session's start or the Mod's timer) does not pass this Mod's own hooks, so it carries no marker and no `prompt.submit` record; a deferred one, submitted from its `turn.complete` hook, passes its `prompt.submit` hook like a typed prompt and carries the marker. Each wake's `turn.start` and `turn.complete` are recorded.
- A relay request is given up after 3 seconds, but `$.http.fetch` cannot be aborted: against a relay that accepts connections and never answers, a headless run's process exits only when the engine's own timeout (about 30 seconds) ends the abandoned request. At exit the Mod does not start a last flush to a relay whose last request failed.
- Function hooks are early access. A session may print `hooks module not loaded: ... rollout switch` and load the Mod at its first turn start; `session.start` is then recorded at that point. `/relay-spike` answering while its `relay:` line says unreachable means hooks run but the relay cannot be reached from that environment (network or policy), not that hooks do not fire.

## Development

```sh
claude --plugin-dir mods/relay-spike          # run it from this folder for one session
claude plugin validate mods/relay-spike       # what it hooks and calls, and anything the engine would refuse
claude plugin test mods/relay-spike           # tests/*.test.ts, against an in-memory relay and clock
```

Deferred wakes survive a reload of the Mod in `$.state`, declared in `types/index.d.ts`.
