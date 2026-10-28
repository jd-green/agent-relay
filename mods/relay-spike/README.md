# relay-spike

A Claude Code Mod that answers Agent Relay's first milestone (see [`docs/PRD.md`](../../docs/PRD.md)): do Mod hooks fire in a given kind of session (a Project thread, the desktop Code tab, a terminal), which ones, does context a Mod injects reach the model, and can anything start a turn in an idle session?

It reports what it sees to the relay's spike endpoints (`POST /spike/events`, `GET /spike/wake`, [`docs/DESIGN.md`](../../docs/DESIGN.md) section 11). The way to run the spike end to end is in `docs/SPIKE.md`.

## What it does

- **Hook report.** Every occurrence of the hooked events becomes one record `{event, ts, session_id, surface, agent_id, detail}` posted to `/spike/events`. Hooked events: `session.start`, `session.end`, `session.receive`, `session.attach`, `session.detach`, `session.compact`, `turn.start`, `turn.complete`, `prompt.submit`, `prompt.context`, `prompt.compose`, `tool.call`, `agent.spawn`, `command.run`, and `ui.render` of the band above the prompt (once per surface). Every hook passes the event on unchanged; a failing POST never affects one.
- **Injection probe.** Each typed prompt carries one extra line of context the model reads and the person never sees: `relay-spike marker: <nonce>`. Each time it is added, a `context.injected` record is posted with the nonce. Ask the model "What is the relay-spike marker?": if it answers the nonce shown by `/relay-spike` (and in the `session.start` record), injected context reaches the model in that kind of session.
- **Wake probe.** Every `poll_seconds` the Mod asks `GET /spike/wake?session_id=<this session>` for wake requests. For each one, when no turn is running, it submits the wake's text as a prompt and records `wake.submitted`, then `wake.turn_started` once the turn starts (or `wake.failed` with the reason). A wake that arrives while a turn runs is dropped and recorded as `wake.skipped_busy`; one whose turn has not started after two minutes is recorded as `wake.not_started`.
- **Heartbeat.** Every five minutes a `spike.heartbeat` record carries the uptime and the count of every event seen, so the log shows whether the Mod keeps running while a session sits idle.
- **`/relay-spike`.** Shows the marker nonce, whether the relay answers `/health`, whether the token was accepted, how many records were sent, queued, dropped or refused, the last error, and how often each event fired since the Mod loaded.

To ask for a wake, as the human (any session, or omit `session_id` for the first session that polls):

```sh
curl -X POST "$RELAY_URL/spike/wake" \
  -H "Authorization: Bearer $HUMAN_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "Reply with the word awake."}'
```

Read the records back with `GET /spike/events` (human token), or on the relay's `/spike` page.

## Install

At the prompt of a terminal session:

```
/plugin install relay-spike --marketplace jd-green/agent-relay
```

Answer `y` to add the marketplace, pick a scope (user scope loads it in every session), then fill in the options screen. From a shell: `claude plugin install relay-spike --marketplace jd-green/agent-relay`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jd-green/agent-relay`, then Add plugin. A private repository installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | string, required | | Base URL of the relay Worker, e.g. `https://agent-relay.<account>.workers.dev`. |
| `role_token` | string, required, sensitive | | Any role's bearer token; spike events accept every role. Kept in secure storage, not in settings.json. |
| `poll_seconds` | number | `30` | How often to ask for wake requests; at least 15. |

Change the non-secret values later in `/config`, or all of them with `claude plugin configure relay-spike`. An unusable `relay_url` (not http or https) stops the Mod from loading, with that reason.

## Privacy

The records carry event names, timestamps, the session id, the surface (`terminal`, `desktop`, ...), subagent ids, and small metadata only: lengths, tool and command names, origins and reasons, the Claude Code version, the marker nonce, and the values of `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_REMOTE`. They never carry prompt text, model answers, tool inputs or outputs, file contents, wake text (only its length) or the token. The token is sent only to `relay_url`, in the `Authorization` header.

## Behaviour worth knowing

- Records are buffered and posted in batches of up to 20 every 5 seconds. After a failed POST the Mod waits 10 seconds, doubling up to 5 minutes; it keeps up to 500 records meanwhile, dropping the oldest. A record the relay refuses as invalid is dropped alone.
- At most 50 records per event name are posted per load; later occurrences are only counted (in the heartbeat and `/relay-spike`), so a busy session cannot flood the relay. Counts start again when the Mod reloads.
- A wake is a plugin prompt: the transcript shows it as sent by the relay-spike plugin, and it does not pass this Mod's own hooks, so it carries no marker and no `prompt.submit` record. Its turn's `turn.start` and `turn.complete` are recorded.
- Function hooks are early access. A session may print `hooks module not loaded: ... rollout switch` and load the Mod at its first turn start; `session.start` is then recorded at that point.

## Development

```sh
claude --plugin-dir mods/relay-spike          # run it from this folder for one session
claude plugin validate mods/relay-spike       # what it hooks and calls, and anything the engine would refuse
claude plugin test mods/relay-spike           # tests/*.test.ts, against an in-memory relay and clock
```
