# relay-inbox

A Claude Code Mod that connects a session to Agent Relay as one role: it watches that role's relay inbox, shows new messages in a band above the prompt, hands them to the model with the next prompt, and wakes the session when messages arrive while it sits idle. It is the wake path and inbox band of [`docs/PRD.md`](../../docs/PRD.md) (Architecture, "Inbox Mod", and milestone 7), built on the relay's JSON API ([`docs/DESIGN.md`](../../docs/DESIGN.md) sections 11 and 14).

## What it does

- **Polls the inbox.** At session start and then every `poll_seconds` it calls `GET /api/inbox?peek=1&session_ref=<session id>`, which lists the role's unread messages across active builds without marking them read (and records which session polled, for the ledger's presence view).
- **Band above the prompt.** While messages are unread, the band reads `Relay · 2 unread · creative-director → review_request (T2)` (the newest message's sender, type and task) with two buttons. **Read** runs `/relay`. **Reply** puts `/relay-reply ` in the prompt box, keeping whatever was typed as the reply's text. Nothing is drawn while nothing is unread. The band is drawn in the terminal and the desktop app.
- **Status line.** `Relay · 2 unread · b-xxxxxxxxxx in_progress`, or what is wrong: `connecting…`, `token rejected (401)`, `unreachable (…), retrying in 2m`, `halted: <reason>`.
- **Next-turn context.** The next prompt you send carries the unread messages as context the model reads and you do not see: for each, its id, build, sender, type, task, verdict, numbered changes, links, `reply_to` and body (bodies over 4,000 characters are cut, the full text stays in the ledger). They are framed as messages from other roles, to be handled under the relay protocol. Right after, the Mod marks them read (`POST /api/call/inbox {peek: false}`), so they are never handed over twice. A message that arrives between the poll and that call is carried to the following prompt.
- **Auto-wake** (`auto_wake`, on by default). When unread messages exist, no turn is running, and those messages have not woken the session before, the Mod submits the prompt `[relay] N new relay message(s) for build <id>. Check your relay inbox and act per the relay protocol.` The role then reads its inbox with the relay's `inbox` tool. Guards: at most one wake per new batch of messages, at least 120 seconds between wakes, none in the first 10 seconds of a session (a prompt already on its way goes first), none while a turn runs, none while the relay's kill switch is on or the build is halted.
- **`/relay`.** Lists the unread messages and the last few earlier ones, marks them read, and hands the new ones to the model as context of the command, so the next turn has them.
- **`/relay-reply <text>`.** Sends a `status` message with that text to the sender of the newest message (for a relay nudge, to the role it speaks for), in the same build, with `reply_to` set to that message. The reply is sent as this session's role.

## Install

At the prompt of a terminal session:

```
/plugin install relay-inbox --marketplace jd-green/agent-relay
```

Answer `y` to add the marketplace, pick a scope, then fill in the options screen. From a shell: `claude plugin install relay-inbox --marketplace jd-green/agent-relay`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jd-green/agent-relay`, then Add plugin. A private repository installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com.

Install it once per role session: each session's `role_token` decides whose inbox it shows and as whom replies are sent.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `relay_url` | string, required | | Base URL of the relay Worker, e.g. `https://agent-relay.<account>.workers.dev`. |
| `role_token` | string, required, sensitive | | The bearer token of the role this session plays. Kept in secure storage, not in settings.json. |
| `poll_seconds` | number | `60` | How often to check for unread messages; at least 15. |
| `auto_wake` | boolean | `true` | Start a turn when new messages arrive while the session is idle. |

Change the non-secret values later in `/config`, or all of them with `claude plugin configure relay-inbox`. An unusable `relay_url` (not http or https) stops the Mod from loading, with that reason.

## Failure handling

A relay that does not answer, answers an error, or takes over 8 seconds shows in the status line; the Mod then waits twice the poll interval, doubling up to 10 minutes, before trying again. A rejected token (401) waits the full 10 minutes. No hook ever fails because of the relay: prompts go through, without relay context, whatever state it is in.

## Privacy

The Mod talks only to `relay_url`, sending the role token in the `Authorization` header, the session id as `session_ref`, and the reply text you give `/relay-reply`. Messages from other roles enter the model's context as described above; nothing from the conversation is sent to the relay unless the model or you send it.

## Development

```sh
claude --plugin-dir mods/relay-inbox          # run it from this folder for one session
claude plugin validate mods/relay-inbox       # what it hooks and calls, and anything the engine would refuse
claude plugin test mods/relay-inbox           # tests/*.test.tsx, against an in-memory relay and clock
```

What survives a reload of the Mod (unread messages, which messages were handed over or woke the session) is kept in `$.state`, declared in `types/index.d.ts`.
