# Spike runbook: wake-up and Mods (PRD milestone 1)

The build depends on one question: can something outside a Project thread wake it and put the relay's messages in front of the model? This runbook answers it with the `relay-spike` Mod and picks the wake path. Milestone 1 exits when you know whether Project threads can be woken and receive injected context, or the fallback is chosen.

Setup steps referenced here (deploy, tokens, `human_auth`, Mod install) are in [`SETUP.md`](SETUP.md).

## What the relay-spike Mod does

- **Logs every hook event** it sees to `POST /spike/events`: the event name, time, session id, surface (`terminal`, `desktop`, `vscode` or `mobile`) and small metadata, never prompt or file contents. The relay keeps the newest 5,000 events.
- **Injects a marker** each turn: a line `relay-spike marker: <nonce>` in the model's context. If the model can quote it, injection works.
- **Polls for wakes** every `poll_seconds` with `GET /spike/wake`. When a wake is waiting and the session is idle, it tries `$.prompt.submit` with the wake's text. A turn that starts by itself means wake works.
- **`/relay-spike`** shows the Mod's state in the current session: the marker nonce, whether the relay answers and accepts the token, events sent, wake polls, the last error and the hook events seen since it loaded. The session id is in the `#spike` event list.

## Before you start

1. The relay is deployed and the tokens are uploaded (SETUP §3).
2. Open `https://<worker>/#spike` and sign in with the human token. Keep it open: it lists events newest first, tallies them by name and session, and has the **Queue a wake** panel.
3. Install `relay-spike` (SETUP §6) with `relay_url`, `role_token` set to the developer's token (any role token works; keep James's token out of Mods), and `poll_seconds` set to 15.
4. Note the date and versions: the Claude desktop app, `claude --version`, the phone app.

## A. A Project thread (desktop app, then web)

1. In the Claude desktop app, open the Full-Stack Developer Project and start a new thread. Send: `Spike test: say hello.`
2. Refresh `#spike`. Did events arrive? Which names (session start, prompt submit, tool calls, turn end) and which `surface`? Note the session id.
3. Ask: `Is there a line starting with "relay-spike marker:" in your context? Quote it exactly, or say there is none.` Compare the nonce with the one the Mod reports (`/relay-spike`, or the detail of that session's `session.start` event).
4. Type `/relay-spike`. Does the command exist here?
5. Leave the thread idle. In `#spike`, queue a wake for that session id with the text `Spike wake: reply with WAKE-OK and the time.` Wait at least 30 seconds (two polls). Did a turn start without you? Note the delay.
6. Repeat step 5 with another thread in front, with the app minimised, and with the app quit (then reopen it and check whether the turn ran).
7. Open a thread in a second Project (e.g. Creative Director) and send a message. In `#spike`, check which token role its events carry (the `token` field). If every Project's events carry the same role, the Mod's settings are per machine rather than per Project: record it, because Plan A then needs another way to give each Project its own role token.
8. Repeat steps 1 to 6 on claude.ai in a browser, and in the phone app (Mods are unlikely to load there; record what you see).

## B. A local Claude Code session

1. In a terminal: `mkdir -p ~/relay-spike && cd ~/relay-spike && claude`. Run steps 1 to 6 of section A in it.
2. Do the same in the desktop app's Code tab (a local session).
3. Optional, Plan B end to end: give that directory a `CLAUDE.md` with the Developer Project's instructions plus [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) and [`protocol/roles/developer.md`](../protocol/roles/developer.md), connect the relay with `claude mcp add` (SETUP §4), then queue the wake text `Check your relay inbox.` and confirm the session calls `inbox`.

## Queue a wake or read events with curl

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' \
  -d '{"session_id": "<session id>", "text": "Spike wake: reply with WAKE-OK and the time."}' \
  "$RELAY_URL/spike/wake"

human_auth | curl -sS -H @- "$RELAY_URL/spike/events?limit=50"
```

Without `session_id` a wake goes to whichever session polls first, and that session consumes it, so name the session whenever more than one is running. `since` on `/spike/events` takes an event id or an ISO-8601 time.

## C. Scheduled tasks

Can a schedule start a turn in a role's context without you?

1. In the Developer Project, wherever your Claude app offers scheduled tasks, create one that runs every 15 minutes (or the shortest interval offered) with the prompt `Scheduled spike check: call whoami on the relay, then reply SCHEDULED-OK and the role it returned.`
2. Record: did it run on time without you; did it run inside the Project (Project instructions and the relay connector present, so `whoami` returns `developer`); did it reuse one thread or start a new one each time; did `relay-spike` events arrive for it, and with which surface; what is the shortest interval.
3. In a local Claude Code session, try a recurring prompt: `/loop 15m Check your relay inbox and act on it.` Record whether it keeps firing while the session sits idle.
4. Delete the scheduled tasks afterwards.

## D. Phone and Remote Control

1. **Phone to a Project thread.** In the Claude phone app, open the thread from section A and send `Spike phone test: reply PHONE-OK.` Record whether the reply arrives, whether `relay-spike` events arrive for that turn (and with which surface), and whether the marker is visible.
2. **Phone to a local session over Remote Control.** In the local session from section B, turn on Remote Control (`/remote-control`), open the session in the phone app, and send `Spike remote test: reply REMOTE-OK.` Record whether it reaches the session, whether hooks fire and the marker is visible, and the round-trip time.
3. **Gates from the phone.** Open `https://<worker>/` on the phone, sign in, and check that the gate buttons and the kill switch are usable there.

## What to record

Copy this table into the Results section below and fill it in. Each session's `session.start` event detail (surface, entrypoint, whether it runs remotely, version) tells you which surface a row is really about.

| Surface | Hooks seen (event names) | Marker quoted | `/relay-spike` | Wake started a turn (delay) | Wake in background / app quit | Notes |
|---|---|---|---|---|---|---|
| Project thread, desktop app | | | | | | |
| Project thread, web | | | | | | |
| Project thread, phone | | | | | | |
| Claude Code, terminal | | | | | | |
| Claude Code, desktop Code tab | | | | | | |
| Scheduled task (Project) | | | | | | ran unattended? in Project context? same thread? interval? |
| `/loop` (Claude Code) | | | | | | |
| Remote Control from phone | | | | | | |

## Decide

| What you saw in Project threads | Plan |
|---|---|
| Hooks fire, the marker is quoted and a wake starts a turn | **Plan A.** Install `relay-inbox` with `auto_wake` on so it runs in each role's Project threads, each with that role's token (see step A7). The roles stay in their Projects. |
| Hooks fire and the marker is quoted, but no wake starts a turn | **Plan A for injection, plus a separate wake.** Install `relay-inbox` in the Projects for injection and the inbox band. Wake each role with a scheduled task ("Check your relay inbox and act on it", every 15 minutes or less) if section C worked; otherwise use Plan B for the wake. |
| Hooks fire but the marker never reaches the model | Injection doesn't work, so treat it like the next row. |
| Nothing fires in Project threads | **Plan B.** Run each role as a local or background Claude Code session loaded with its Project's instructions, with `relay-inbox` providing the wake. |

A wake every 15 minutes or less keeps roles ahead of the 30-minute nudge, so a woken role answers before a second nudge escalates to you.

### Plan B setup

1. Make one directory per role, e.g. `~/relay-roles/orchestrator`, `~/relay-roles/creative-director` and `~/relay-roles/developer`.
2. In each, write a `CLAUDE.md` holding the role Project's instructions, then `protocol/PROTOCOL.md`, then the role's addendum.
3. In each, connect the relay with that role's token (local scope): `claude mcp add --transport http relay https://<worker>/mcp --header "Authorization: Bearer $(op read 'op://Agent Relay/<Role> token/password')"`.
4. In each, install `relay-inbox` (local scope) with that role's token and `auto_wake` on.
5. Start `claude` in each directory (terminal tabs or tmux) and leave the sessions idle; messages wake them. Turn on Remote Control to watch them from the phone, and use the ledger page for gates.

## Exit

Milestone 1 is done when the table is filled in and a plan is chosen. Write both in the Results section, update the Status line in [`README.md`](../README.md), and uninstall `relay-spike` from the `/plugin` menu.

## Results

Not run yet. Record the date, the app versions, the filled-in table and the chosen plan here.
