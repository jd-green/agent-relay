# relay-inbox

A Claude Code Mod that connects a session to Agent Relay as one role: it watches that role's relay inbox, shows new messages in a band above the prompt, hands them to the model with the next prompt, and wakes the session when messages arrive while it sits idle. It is the wake path and inbox band of [`docs/PRD.md`](../../docs/PRD.md) (Architecture, "Inbox Mod", and milestone 7), built on the relay's JSON API ([`docs/DESIGN.md`](../../docs/DESIGN.md) sections 11 and 14).

## What it does

- **Polls the inbox.** At session start and then every `poll_seconds` it calls `GET /api/inbox?peek=1&session_ref=<session id>`, which lists the role's unread messages without marking them read (and records which session polled, for the ledger's presence view). Polls only feed the band, the status line and the wake decision: they never mark anything read.
- **Band above the prompt.** While messages are unread, the band reads `Relay · 2 unread · creative-director → review_request (T2)` (the newest message's sender, type and task) with two buttons. **Read** runs `/relay`. **Reply** puts `/relay-reply ` in the prompt box, keeping whatever was typed as the reply's text. While a halt holds the messages back it says so: `Relay · halted: <reason> · 2 unread · …` for the kill switch, `Relay · build halted · …` when every build with unread mail is halted. Nothing is drawn while nothing is unread. The band is drawn in the terminal and the desktop app.
- **Status line.** `Relay · 2 unread · b-xxxxxxxxxx in_progress`, or what is wrong: `connecting…`, `token rejected (401)`, `unreachable (…), retrying in 2m`, `halted: <reason>`.
- **Next-turn context, read atomically.** When you send a prompt that starts a turn, the Mod reads the inbox for it: a fresh peek, then `POST /api/call/inbox {build_id, peek: false, limit: 100}` for each build whose mail may be delivered, all within 1.5 seconds. The prompt carries exactly what those reads returned, which the relay has now marked read: nothing else is ever marked read by the Mod, and there is no separate mark-read step. If the relay is slow, failing or backing off, the prompt goes without (the model's own `inbox` call covers it) and nothing is marked read. A read that answers only after its prompt went, or whose prompt did not enter (a hook below refused it), is added to the conversation as a user-role row the model reads at its next request, so a message the relay marked read always reaches the model. A slash command, and a prompt typed while a turn runs, carry nothing: that turn's own inbox calls cover it.
- **What the model reads.** The context block starts `Agent Relay inbox: N new message(s) for you (<role>)`, says they are already marked read (the `inbox` tool will not list them again, so the model acts on them as if `inbox` had returned them) and frames them as messages from other roles, handled under the relay protocol. Each message has a header line the Mod writes, `[M4] build b-… "Title" · from <role> (for <role>) · to <role> · type <type> · task T2 · verdict … · reply to M3 · <time>`, then its numbered changes, links and body. Every line an author wrote starts with `  | `, so a body cannot forge a header (say one `from human`). Bodies over 4,000 characters are cut; the full text stays in the ledger.
- **Halts.** While the relay reports the kill switch on, or every build with unread mail is halted, prompts carry nothing and the messages stay unread on the relay, to be delivered after the halt ends. A halted build's mail stays unread while other builds' mail is delivered. If the kill switch goes on in the instant between the Mod's check and its read, the messages it read are handed over with a line telling the model the relay is halted.
- **Auto-wake** (`auto_wake`, on by default). When unread messages exist, no turn is running, and those messages have not woken the session before, the Mod peeks again (unless it just did) and, if they are still unread on the relay, submits the prompt `[relay] N new relay message(s) for build <id>. Check your relay inbox and act per the relay protocol.` The role then reads its inbox with the relay's `inbox` tool. Guards: at most one wake per new batch of messages, at least 120 seconds between wakes, none in the first 10 seconds of a session (a prompt already on its way goes first), none while a turn runs, none while the relay's kill switch is on or the build is halted.
- **`/relay`.** Reads the unread messages (marking them read), lists them and the last few earlier ones, and hands what it read to the model as context of the command, so the next turn has them. While halted it lists them and leaves them unread.
- **`/relay-reply <text>`.** Sends a `status` message with that text to the sender of the newest message (for a relay nudge, to the role it speaks for), in the same build, with `reply_to` set to that message and `task_id` set to its task. Because the reply names the task, answering a nudge this way counts as activity on it and resets the nudge. The reply is sent as this session's role.

## One copy serves one role

Claude Code stores a plugin's options once per user and machine (the `role_token` in secure storage), whatever scope the plugin is installed at and whatever directory or Project the session runs in. So one installed copy of relay-inbox serves exactly one role on a machine: installing it again in a second role's directory replaces the first role's URL and token for every session.

- **Several roles on one machine** (Plan B in `docs/SPIKE.md`): do not install the Mod. Start each role's session with `scripts/role-session.sh <role>`, which runs `claude --plugin-dir <repo>/mods/relay-inbox --settings <role-dir>/.relay-inbox.json`, the options file holding `{"pluginConfigs": {"relay-inbox": {"options": {"relay_url": …, "role_token": …}}}}` for that role (written with `chmod 600`, never committed). Do not also install relay-inbox from the marketplace, or two copies load.
- **Never install relay-inbox at user scope.** It would load in every session on the machine, hand that role's messages to whatever prompt is typed there (marking them read, so the real role session never sees them) and wake unrelated sessions. Run it only in the role's own session, and only one session per role at a time.
- **After starting a session, send one prompt** (for example `Check your relay inbox.`) and check that the `Relay · …` status line appears before leaving it idle. Function hooks are early access: when the engine's rollout switch has not answered at startup it loads the hooks module at the first turn start, and until then an idle session neither polls nor wakes.

## Install

For one role on a machine, at the prompt of a terminal session in that role's directory:

```
/plugin install relay-inbox --marketplace jd-green/agent-relay
```

Answer `y` to add the marketplace, choose the **local** scope (never user scope, see above), then fill in the options screen. From a shell: `claude plugin install relay-inbox --marketplace jd-green/agent-relay --scope local`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jd-green/agent-relay`, then Add plugin. A private repository installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | string, required | | Base URL of the relay Worker, e.g. `https://agent-relay.<account>.workers.dev`. Must be `https`; plain `http://` is accepted only for `localhost` and `127.0.0.1`, so the token never crosses a network in clear text. |
| `role_token` | string, required, sensitive | | The bearer token of the role this session plays. Kept in secure storage, not in settings.json. |
| `poll_seconds` | number | `60` | How often to check for unread messages; at least 15. |
| `auto_wake` | boolean | `true` | Start a turn when new messages arrive while the session is idle. |

Change the non-secret values later in `/config`, or any of them with `/plugin configure relay-inbox@agent-relay` in a session, or from a shell with `echo '{"poll_seconds": 30}' | claude plugin configure relay-inbox@agent-relay --values-stdin`. `claude plugin configure` needs the full id (`relay-inbox@agent-relay`, as `claude plugin list` shows it) and without `--values-stdin` only lists the options and which are unset. With `--plugin-dir` the options come from `--settings`, under `pluginConfigs["relay-inbox"].options`. An unusable `relay_url` (not https, or http to another host) stops the Mod from loading, with that reason.

## Failure handling

A relay that does not answer, answers an error, or takes over 3 seconds shows in the status line; the Mod then waits twice the poll interval, doubling up to 10 minutes, before trying again, and prompts made meanwhile neither wait for it nor ask it. A rejected token (401) waits the full 10 minutes. A prompt waits at most 1.5 seconds for its read. No hook ever fails because of the relay: prompts go through, without relay context, whatever state it is in.

`$.http.fetch` cannot be aborted: a request the Mod gave up on stays open until the engine's own timeout (about 30 seconds) ends it. So against a relay that accepts connections and never answers, a headless `claude -p` run answers on time but its process exits only about 30 seconds after the Mod's first request (against a relay that is down, it exits at once).

## Privacy

The Mod talks only to `relay_url`, sending the role token in the `Authorization` header, the session id as `session_ref`, and the reply text you give `/relay-reply`. Messages from other roles enter the model's context as described above; nothing from the conversation is sent to the relay unless the model or you send it.

## Development

```sh
claude --plugin-dir mods/relay-inbox          # run it from this folder for one session
claude plugin validate mods/relay-inbox       # what it hooks and calls, and anything the engine would refuse
claude plugin test mods/relay-inbox           # tests/*.test.tsx, against an in-memory relay and clock
```

What survives a reload of the Mod (the last peek, which messages were handed over or woke the session) is kept in `$.state`, declared in `types/index.d.ts`. `test/live/mods.test.mjs` runs both Mods in real `claude -p` sessions against a local relay (see `test/live/README.md`).
