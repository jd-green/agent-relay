# Spike runbook: wake-up and Mods (PRD milestone 1)

The build depends on one question: can something outside a Project thread wake it and put the relay's messages in front of the model? This runbook answers it with the `relay-spike` Mod and picks the wake path. Milestone 1 exits when you know whether Project threads can be woken and receive injected context, or the fallback is chosen.

Setup steps referenced here (deploy, tokens, `human_auth`, Mods) are in [`SETUP.md`](SETUP.md).

One thing is already known: a Mod's options (`relay_url`, `role_token`) are stored **once per user and machine**, whatever scope it is installed at and whatever Project a thread belongs to (SETUP §6). So a Mod installed for Project threads holds one role's token for all of them. Plan A therefore also needs a Mod that can tell one Project's threads from another's, which step A7 checks.

## What the relay-spike Mod does

- **Logs every hook event** it sees to `POST /spike/events`: the event name, time, session id, surface (`terminal`, `desktop`, `vscode` or `mobile`) and small metadata, never prompt or file contents. The relay stamps each record with the token's `role` and keeps the newest 5,000.
- **Records which Project a thread is**, without the text: each `prompt.context` record lists the context blocks' names (`claudeMd`, `attachedProject`, `currentDate`, …) with a SHA-256 prefix and length of the `attachedProject` block (`null` when there is none) and of the session's directory.
- **Injects a marker** each turn: a line `relay-spike marker: <nonce>` in the model's context. The nonce is derived from the session id, so it stays the same for the whole conversation. If the model can quote it, injection works.
- **Polls for wakes** every `poll_seconds` with `GET /spike/wake?session_id=<this session>`, which returns only wakes queued for its token's role that name this session or no session. When one is waiting and the session is idle, it submits the wake's text with `$.prompt.submit`; a wake that arrives during a turn waits for that turn to end (`wake.deferred`). A turn that starts by itself means wake works.
- **`/relay-spike`** shows the Mod's state in the current session: the marker nonce, `relay:` (whether the relay answers and accepts the token), `events:` (records sent, queued, dropped), deferred wakes, the last error and the hook events seen since it loaded. The session id is in the `#spike` event list.

## Before you start

1. The relay is deployed and the tokens are uploaded (SETUP §3).
2. Open `https://<worker>/#spike` and sign in with the human token. Keep it open: it lists events newest first, tallies them by name and session, and has the **Queue a wake** panel (a role, plus an optional session id).
3. Install `relay-spike` (SETUP §6) with `relay_url`, `role_token` set to the developer's token (any role token works; keep James's token out of Mods), and `poll_seconds` set to 15. Install it at **user** scope, since Project threads have no directory of their own, and only for the spike: while it is installed, every session on this machine loads it and can take its role's wakes, so run no role session or rehearsal next to it, and remove it when the spike is done.
4. Note the date and versions: the Claude desktop app, `claude --version`, the phone app.

## A. A Project thread (desktop app, then web)

1. In the Claude desktop app, open the Full-Stack Developer Project and start a new thread. Send: `Spike test: say hello.`
2. Refresh `#spike`. Did events arrive? Which names (session start, prompt submit, tool calls, turn end) and which `surface`? Note the session id.
3. Ask: `Is there a line starting with "relay-spike marker:" in your context? Quote it exactly, or say there is none.` Compare the nonce with the one the Mod reports (`/relay-spike`, or the detail of that session's `session.start` event).
4. Type `/relay-spike`. Does the command exist here? If it does, read its `relay:` and `events:` lines. Command present but the relay unreachable, or `events: 0 sent`, means hooks run but this environment can't reach the relay (cloud egress or an org network policy): record a network problem, not "nothing fires". No command and no events at all means hooks don't run here.
5. Leave the thread idle. In `#spike`, queue a wake for role `developer` and that session id with the text `Spike wake: reply with WAKE-OK and the time.` Wait at least 30 seconds (two polls). Did a turn start without you? Note the delay.
6. Repeat step 5 with another thread in front, with the app minimised, and with the app quit (then reopen it and check whether the turn ran).
7. **Can a Mod tell Projects apart?** Start a thread in a second Project (e.g. Creative Director) and send a message; send another in a second thread of the first Project. In `#spike`, compare the `prompt.context` records of the three threads: their `blocks`, the `attached_project` fingerprint and the `cwd` fingerprint. Two threads of one Project should share an `attached_project` fingerprint and the two Projects should differ. Record whether they do. (Every record carries `role: developer`, the one configured token: that is the per-machine setting, not a finding.)
8. Repeat steps 1 to 6 on claude.ai in a browser, and in the phone app (Mods are unlikely to load there; record what you see).

## B. A local Claude Code session

1. In a terminal: `mkdir -p ~/relay-spike && cd ~/relay-spike && claude`. Run steps 1 to 6 of section A in it.
2. Do the same in the desktop app's Code tab (a local session).
3. Optional, Plan B end to end: start the developer as in [Plan B setup](#plan-b-setup) below (relay-spike, still installed, loads there too), then queue the wake text `Check your relay inbox.` for role `developer` and that session's id, and confirm the session calls `inbox`.

## Queue a wake or read events with curl

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' \
  -d '{"role": "developer", "session_id": "<session id>", "text": "Spike wake: reply with WAKE-OK and the time."}' \
  "$RELAY_URL/spike/wake"

human_auth | curl -sS -H @- "$RELAY_URL/spike/events?limit=50"
```

Always name the `role` whose session should run the wake (only a Mod holding that role's token receives it) and, whenever more than one session of that role may be polling, its `session_id`: a wake without one goes to the first session of that role that polls, and that session consumes it. `since` on `/spike/events` takes an event id or an ISO-8601 time.

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

| Surface | Hooks seen (event names) | Relay reachable (`/relay-spike`) | Marker quoted | Wake started a turn (delay) | Wake in background / app quit | Projects told apart (A7) | Notes |
|---|---|---|---|---|---|---|---|
| Project thread, desktop app | | | | | | | |
| Project thread, web | | | | | | | |
| Project thread, phone | | | | | | | |
| Claude Code, terminal | | | | | | n/a | |
| Claude Code, desktop Code tab | | | | | | n/a | |
| Scheduled task (Project) | | | | | | | ran unattended? in Project context? same thread? interval? |
| `/loop` (Claude Code) | | | | | | n/a | |
| Remote Control from phone | | | | | | n/a | |

## Decide

| What you saw in Project threads | Plan |
|---|---|
| Hooks fire, the marker is quoted, a wake starts a turn, and A7 tells Projects apart | **Plan A.** relay-inbox runs in each role's Project threads. Because its options are per machine, it first needs a change: pick the role per thread from the `attachedProject` fingerprint (a Project → role map, with the role tokens in one sensitive option). The roles stay in their Projects. |
| As above, but A7 can't tell Projects apart | **Plan A for one role per machine** (or per OS user account), or **Plan B**. One installed relay-inbox serves one role. |
| Hooks fire and the marker is quoted, but no wake starts a turn | **Plan A for injection, plus a separate wake.** relay-inbox gives injection and the inbox band (subject to A7). Wake each role with a scheduled task ("Check your relay inbox and act on it", every 15 minutes or less) if section C worked; otherwise use Plan B for the wake. |
| Hooks fire but the marker never reaches the model | Injection doesn't work, so treat it like the next row. |
| Hooks run but `/relay-spike` shows the relay unreachable | A network problem, not a hooks problem: fix egress to the Worker (or the org's web-access policy) and repeat section A before deciding. |
| Nothing fires in Project threads (no events, no `/relay-spike`) | **Plan B.** Run each role as a local Claude Code session loaded with its Project's instructions, with relay-inbox providing the wake. |

A wake every 15 minutes or less keeps roles ahead of the 30-minute nudge, so a woken role answers before a second nudge escalates to you.

### Plan B setup

1. Make one directory per role, e.g. `~/relay-roles/orchestrator`, `~/relay-roles/creative-director` and `~/relay-roles/developer` (the launcher's defaults).
2. In each, write a `CLAUDE.md` holding only the role Project's own instructions (its job, skills and connectors). The protocol and the role's addendum are added at every start by the launcher.
3. Don't install relay-inbox, and don't `claude mcp add` the relay in these directories: the launcher brings both, per role. Once the spike is over, remove relay-spike (it was installed at user scope).
4. Start each role in its own terminal tab or tmux window: `export RELAY_URL=https://<worker>`, then `scripts/role-session.sh orchestrator`, `scripts/role-session.sh creative-director` and `scripts/role-session.sh developer` from this repo (SETUP §6). Each reads its token with `op read`, checks it with the relay, writes its private settings to `~/.local/state/agent-relay/<role>/` (under `$XDG_STATE_HOME` if set; never into the role directory), and starts `claude` with relay-inbox, the relay MCP server and the protocol for that role only, without your 1Password session or Cloudflare token in its environment. Run as one OS user, the roles are not isolated from each other: read SETUP §6, Threat model, before using real tokens.
5. Each session starts with one prompt that checks its inbox, which also loads a hooks module the engine deferred to the first turn. Check that the `Relay · …` status line appears in each, then leave them idle; messages wake them. Run one session per role at a time.
6. To watch them from the phone, start them with Remote Control (`scripts/role-session.sh developer -- --remote-control`, or `/remote-control` in the session), and use the ledger page for gates.

## Exit

Milestone 1 is done when the table is filled in and a plan is chosen. Write both in the Results section, update the Status line in [`README.md`](../README.md), and uninstall `relay-spike` from the `/plugin` menu (or `claude plugin uninstall relay-spike@agent-relay`).

## Results

Not run yet. Record the date, the app versions, the filled-in table and the chosen plan here.
