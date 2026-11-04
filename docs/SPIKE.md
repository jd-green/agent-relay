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

**Run completed for Max-accessible surfaces:** 2026-10-30, 14:00–15:16 CT, by Max on his own Mac (not James's) against the deployed relay `https://agent-relay.dominion-equity.workers.dev` (main 13f83cb, version 4cd59511). Claude Code 2.1.314 (terminal, `claude --plugin-dir mods/relay-spike`, model haiku, `poll_seconds` 15, developer token). claude.ai in a browser, signed in as James (Ultra). The Claude desktop app and the phone app were not used: they are on James's devices. The live suite reported $0.0296 for 24 sessions (20/20 checks). The deployed terminal trial was also small, but its exact incremental cost has not been totaled; the shared account status line is not a trial cost meter. The claude.ai runs used James's plan.

### What changed since the runbook was written

In this account, the tested **Project is a Claude Code project** (`claude.ai/code/project/…`): a coordinator that starts threads, each thread a Claude Code session in **Anthropic's cloud** (Linux container) unless the Project allows "Let Claude use your device", which runs Remote Control threads on that device. James's ⛰ Creative Director Project is this kind too. So section A on the web tests cloud Claude Code sessions, and section A in the desktop app may run locally, where installed Mods load. The scheduled tasks of section C are now **routines**, and a routine can also have an **API trigger** (`POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire` with a per-routine token and a `text` body): an outside wake the runbook did not list.

### Table

| Surface | Hooks seen (event names) | Relay reachable (`/relay-spike`) | Marker quoted | Wake started a turn (delay) | Wake in background / app quit | Projects told apart (A7) | Notes |
|---|---|---|---|---|---|---|---|
| Project thread, desktop app | needs James's device | | | | | | Check whether the thread runs locally (Project setting "Let Claude use your device") and whether a locally installed relay-spike loads there. Steps below. |
| Project thread, web | none: no events from the thread's session | no `/relay-spike` command (the thread listed only built-in and account skills) | **no** (the model said no such line) | no: nothing to wake (no Mod) | n/a | not testable (no `prompt.context` records) | Thread runs in a cloud container. Its shell's egress proxy **blocks** `agent-relay.dominion-equity.workers.dev` (`curl` refused). This does not establish how an uploaded Mod's HTTP API would behave; no cloud Mod was configured. The connector itself works there (`whoami` → `developer`): connector calls go from Anthropic's side, not the container. |
| Project thread, phone | needs James's device | | | | | | Likely the same cloud thread as on the web. |
| Claude Code, terminal | `session.start`, `prompt.context`, `prompt.compose`, `prompt.submit`, `context.injected`, `turn.start`, `turn.complete`, `tool.call`, `command.run`, `ui.render.AbovePrompt`, `spike.heartbeat`, `session.end`, `wake.submitted`, `wake.turn_started` | yes: `relay: reachable · token: accepted` (one transient `ECONNRESET` on a POST, retried) | **yes**: `e156258d`, same as `/relay-spike` and the `session.start` record | **yes**: W1 submitted by the Mod at 19:03:11.655Z; turn started at 19:03:11.702Z (47 ms after submission; 15 s poll interval, not a measured queue-to-turn bound) | **W2/W3**: additional wakes also ran (19:04:11Z, 19:23:11Z). Attempts to hold the model in a long turn with `sleep` were refused by its permissions, so these do **not** prove deferred mid-turn handling. **Quit**: W4 queued while `claude` was not running; on `claude --resume` of the same session it was taken at the first poll and ran at once (19:24:55Z). The session must be resumed: a quit session is not woken. | n/a | Session open for 20 minutes with unattended `/loop` turns and heartbeats every 5 minutes; 81 wake polls; no drops. A wake is shown as "Prompt from the relay-spike plugin". A `claude -p` run also loaded the Mod and quoted its marker (`9e2688dc`). |
| Claude Code, desktop Code tab | needs James's device | | | | | n/a | |
| Scheduled task (Project) | none (no Mod in the cloud) | n/a | no | **yes, unattended**: due 15:12 CT; `scheduled_trigger` session created 20:14:34.697Z (about 2 min 35 s late), reply at 20:14:51Z | runs in the cloud: James's devices can be off | n/a | The task form has **no Project picker**: it runs as a plain chat (Sonnet 5.5), not inside a Project, so no Project instructions. Connectors: all of the account's, `Relay · Developer` included (`whoami` → `developer`). Manual and unattended runs created **different** cloud sessions and chats outside the Project. The unattended reply reported no marker and no named Project instructions. Shortest interval offered: **hourly**. |
| Routine, API trigger | n/a | n/a | no | **yes**: `POST …/fire` at 19:20:37Z returned a session URL; the run answered at 19:20:49Z (12 s), quoting the `text` sent with the fire and `whoami` → `developer` | runs in the cloud | n/a | Not in the runbook. Each fire is a **new session** with the routine's own instructions and connectors (all of the account's by default; can be trimmed), not a Project thread. Token per routine, shown once, regenerable. |
| `/loop` (Claude Code) | `turn.start`/`turn.complete` per run | yes | yes | `/loop 1m` fired every minute (initial answer 19:05:27Z, recurring answers observed 19:06:24–19:21:24Z) while the session sat idle | stops when the session exits (session-only, expires after 7 days) | n/a | `/loop` makes a session cron job (`CronCreate`); minimum 1 minute. Deleted with `CronDelete` after the test. |
| Remote Control from phone | needs James's device | | | | | n/a | |

### Decision

**Plan B**, for the tested setup. In the throwaway web Project, the locally loaded Mod did not appear: no relay-spike hooks, command or marker. Local plugin loading does not configure Anthropic's cloud worker. This is evidence for Plan B on the current setup, **not proof that web Projects can never load uploaded Mods**. The cloud container also reported a blocked shell health request; we did not test a Mod's `$.http.fetch` there or change its allowlist. In local Claude Code hooks, injected context, an idle-session wake, and a queued wake after resume work. `scripts/role-session.sh` uses that local path; the live suite passes (20/20). Deferred mid-turn wakes passed in the isolated live suite, not in the deployed terminal attempt.

Two facts could still change this, and only James's devices can settle the first:

1. **A desktop-app Project thread that runs on the device.** If the Project's "Let Claude use your device" threads run locally and load an installed Mod, roles could stay in their Projects (Plan A), subject to A7. Run this before milestone 2 if keeping Projects matters:
   1. In the Claude desktop app on the MacBook: Customize → Plugins (or **+** → Plugins) → Add marketplace `jd-green/agent-relay` → add **relay-spike**; set `relay_url` to the Worker, `role_token` to the Developer token from 1Password (`Agent Relay - Developer token`), `poll_seconds` 15.
   2. Make a throwaway Project, turn on Project settings → Environment → **Let Claude use your device**, and start a thread that runs on the Mac (Remote Control / local).
   3. Send `Is there a line starting with "relay-spike marker:" in your context? Quote it exactly, or say there is none.`, then `/relay-spike`.
   4. Tell Max the session id from the relay’s `#spike` event list; Max queues a wake for that exact session. Leave the thread idle 30 seconds and see whether `WAKE-OK` appears.
   5. Remove relay-spike and the throwaway Project afterwards.
   If the marker is quoted and the wake runs, Max re-runs A7 (two Projects) from the relay's records and revisits the plan. Otherwise Plan B stands.
2. **A cloud wake via routines (call it Plan C).** A routine per role, holding that role's Project instructions and only that role's connector, fired by the relay's API call when a message arrives, gives a wake that needs no machine on. The cost: every wake is a fresh session with no thread memory (the ledger and inbox carry state), one routine token per role held by the Worker, the cloud environment's default network policy, and plan usage per wake. Worth a design note after milestone 2; not needed to start.

### Evidence and verification

- Deployed terminal session: `91d39d3c-49ee-4d1b-8d50-ef091ca2e16b`. Human-authenticated `/spike/events?limit=500` re-read confirmed 172 records for this session: start/nonce in event 11, W1 submission/turn in 25/27, heartbeat with 81 polls and zero drops in 150, resumed start in 174, W4 submission/turn in 175/178, final exit in 184. `ui.render.AbovePrompt` appears in heartbeat hook counts, not as a separate uploaded event. These timestamps measure Mod submission to turn start, not the earlier external queue request.
- Web test: throwaway Project `chan_01CwGqVTETmfu2m9DZkw99rH` and its “Check relay health endpoint” thread. Project coordinator reported no marker/command; the child thread reported proxy-blocked shell access and successful relay `whoami`. These objects were created for this test and removed afterwards.
- Manual scheduled run: chat `692cff39-948c-8d23-a50e-5e6b6396c549`, `SCHEDULED-OK`, `developer`, 19:13:14Z. API-triggered run: session `cse_01L6aCe6AMwng2zUMRVNqtc2`, `API-OK`, `developer`, 19:20:49Z.
- Unattended scheduled run: `/cowork/scheduled_tasks/trig_011r7b4HNWXMu41Yb1xi3fhA/runs` returned session `cse_01L6aCe4J4VMf6ZgTjPReLpE` with origin **`scheduled_trigger`**, created 20:14:34.697Z, and a new chat `e64b51d8-100f-80e3-b413-0e5f87de1f61`. That chat showed “Ran on schedule” and replied `SCHEDULED-OK`, `developer`, 20:14:51Z; no marker or named Project instructions. The task’s next run advanced to 16:12 CT before deletion. It ran without a manual trigger, but about 2½ minutes after the displayed due time.
- Verification re-run after host recovery: `npm test` **241 passed**; `npm run typecheck` passed; script suite **36 passed** with `TMPDIR` set to its real path (macOS `/var` → `/private/var`; the default alias produced four path-string assertion failures). HTTP/MCP end-to-end tests **76 passed**; the Node Playwright browser suite and optional live MCP suite were skipped. The unit runner printed SQL “no such table” errors during teardown despite passing assertions; this does not establish a clean teardown.
- The earlier live Mod suite reported **20/20** and **$0.0296** for 24 sessions. It exercises deferred wakes on a throwaway local relay; it does not replace the deployed interactive or web trials.

### Clean-up

Local cleanup passed: relay-spike loaded only with `--plugin-dir` (never installed; `claude plugin list` shows no relay plugin), token-bearing temp settings removed, `/loop` job deleted, terminal session exited. Remote cleanup passed: deleted only the throwaway Project "Relay Spike (delete me)" and the two test tasks "Relay Spike check (delete me)" / "Relay Spike API wake (delete me)". Each DELETE returned 200. The fresh Project list excluded the test Project; independent GETs for both deleted triggers returned 404. Deleting the API routine removes its trigger/token target; no post-delete fire was attempted. Its local token file was removed. The existing Developer connector and James’s other Projects were left unchanged. Exact-value scanning found none of the four deployed role tokens in these docs or the branch diff.

The host hit ENOSPC and Chrome stalled during the trial. Primary restored disk headroom and restarted the hung automation browser; the trial resumed and cleanup finished. No redeploy or token rotation was needed. Device-only rows remain explicitly untested, with the desktop check above and the phone/Remote Control checks in sections A8 and D. Plan B is the chosen path for the tested setup; those optional device checks do not establish or block it.
