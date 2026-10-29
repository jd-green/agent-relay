# Setup

From zero to a working relay: local development, deploy and secrets, one connector per role, Project instructions, the Mods, the ledger page and the kill switch. The contract behind all of this is [`DESIGN.md`](DESIGN.md).

Placeholders: `<worker>` is your Worker's host, e.g. `agent-relay.<your-subdomain>.workers.dev`; `<token>` is a role token.

## 1. Prerequisites

- **Node.js 22** and npm. Wrangler is a dev dependency, so use `npx wrangler` (no global install).
- **A Cloudflare account.** The free plan is enough: the relay uses Durable Objects with SQLite storage.
- **1Password** with the CLI (`op` v2) and, ideally, the desktop app's CLI integration. Tokens live in a vault named `Agent Relay` unless you point the scripts elsewhere.
- **Claude** with custom connectors for the role Projects, and **Claude Code** for the Mods and local sessions.
- **This repo pushed to GitHub** (`jd-green/agent-relay`): deploys happen only from pushed commits, and the Mods install from it.

## 2. Local development

```sh
npm ci
node scripts/gen-dev-vars.mjs   # writes .dev.vars (gitignored) and prints a local MCP URL per role
npm run dev                     # wrangler dev on http://127.0.0.1:8787
```

- `gen-dev-vars.mjs` gives each role a random 48-character token. It refuses to overwrite an existing `.dev.vars`; pass `--force` to replace it (every role gets a new token), or `--out <path>` to write elsewhere. [`.dev.vars.example`](../.dev.vars.example) shows the shape.
- `.dev.vars` can also override the `wrangler.jsonc` vars locally, e.g. `NUDGE_AFTER_MINUTES=1` to see nudges quickly.
- Smoke test:

  ```sh
  curl -s http://127.0.0.1:8787/health
  grep '^HUMAN_TOKEN=' .dev.vars | sed 's/^HUMAN_TOKEN=/Authorization: Bearer /' \
    | curl -s -H @- http://127.0.0.1:8787/api/me
  ```

- Ledger page: open http://127.0.0.1:8787/ and sign in with `HUMAN_TOKEN`.
- A role session against the local relay (section 6), taking the role's token from `.dev.vars`:

  ```sh
  (set -a; . ./.dev.vars; RELAY_URL=http://127.0.0.1:8787 scripts/role-session.sh developer)
  ```

Tests:

| Command | What it runs |
|---|---|
| `npm test` | Unit tests inside the Workers runtime (Vitest with the Cloudflare pool) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:e2e` | The end-to-end suite in `test/e2e/`: real HTTP against `wrangler dev`, the official MCP SDK client, Playwright |
| `npm run test:scripts` | Tests for `scripts/role-session.sh` (a fake `claude` on PATH) and for the protocol texts matching the relay |
| `npm run test:live` | The Mods in real `claude -p` sessions against a local relay (costs a few cents with Haiku; see `test/live/README.md`) |
| `npm run rehearsal` | A live PRD loop with three real Claude Code role sessions (costs a few dollars with Sonnet; see `test/live/README.md`) |

## 3. Deploy

1. Sign in: `npx wrangler login`.
2. Deploy **only from a pushed commit**. This guard refuses to deploy a dirty tree or a commit the remote doesn't have:

   ```sh
   test -z "$(git status --porcelain)" && git fetch -q \
     && test "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" && npm run deploy
   ```

   Wrangler prints the Worker URL. Until the secrets exist every role is disabled, so a fresh deploy accepts no token.
3. Create and upload the tokens:

   ```sh
   scripts/put-secrets.sh --generate   # first time: 1Password generates all four tokens, then uploads them
   scripts/put-secrets.sh              # later: upload the tokens already in 1Password
   scripts/put-secrets.sh developer    # one role only
   ```

   The script checks `op whoami`, then for each role pipes `op read` into `npx wrangler secret put <ROLE>_TOKEN`, so no value is printed or passed as an argument. It reads `OP_REF_ORCHESTRATOR`, `OP_REF_CREATIVE_DIRECTOR`, `OP_REF_DEVELOPER` and `OP_REF_HUMAN`, defaulting to `op://Agent Relay/<Role> token/password` (items `Orchestrator token`, `Creative Director token`, `Developer token`, `Human token`). `--generate` gives each item a new 48-character value generated inside 1Password, creating a Password item if it is missing. Tokens must be at least 32 URL-safe characters; shorter ones disable the role.
4. Check: `npx wrangler secret list` shows the four names. Then, with a helper that reads the human token without putting it on a command line:

   ```sh
   export RELAY_URL=https://<worker>
   human_auth() { printf 'Authorization: Bearer %s\n' "$(op read "op://Agent Relay/Human token/password")"; }
   curl -sS "$RELAY_URL/health"
   human_auth | curl -sS -H @- "$RELAY_URL/api/me"
   ```

**Rotate** a token whenever its URL may have leaked: `scripts/put-secrets.sh --generate <role>`, then update that role's connector URL (section 4) and restart its role session (section 6), which reads the new value. A header you added by hand with `claude mcp add`, or a Mod you installed with the old token, needs the new value too.

**Change a setting** (section 9): edit `vars` in `wrangler.jsonc`, commit, push, deploy.

## 4. Connect the roles: one connector per role

Custom connectors belong to your claude.ai account, not to a Project; a Project can only switch on connectors from your account's list. One connector has one URL and so one token, which would give every Project the same identity. So connect the relay **once per role**. This differs from the PRD's "the relay is added once as a custom connector": the relay is deployed once and connected four times.

### claude.ai Projects (desktop app and web)

Connector URL: `https://<worker>/mcp/<role-token>`

The token goes in the path because claude.ai custom connectors may not send custom headers; the relay accepts the last path segment of `/mcp/<token>` as the token. The trade-off: the URL itself is now the secret. It can appear in browser history, screenshots and live logs. Keep it in 1Password, never paste it into a message (the relay rejects any role token with `secret_detected`), and rotate the token if it leaks.

Cloudflare logs: `wrangler.jsonc` turns Workers Logs' invocation logs off (`"logs": {"invocation_logs": false}`), so request URLs are not stored; the Worker's own `console` output still is. A live `npx wrangler tail` (or the dashboard's live log) still shows each request's URL, path tokens included. Give any Cloudflare API token an agent holds (the Developer's deploy token, say) no Workers Tail or Workers Observability permission on the relay's account.

1. Copy a role's URL without it landing in your shell history (macOS):

   ```sh
   printf 'https://%s/mcp/%s' "<worker>" "$(op read "${OP_REF_DEVELOPER:-op://Agent Relay/Developer token/password}")" | pbcopy
   ```

2. In Claude: **Settings → Connectors → Add custom connector**. Name it, paste the URL, leave OAuth empty, and add it.
3. Repeat for each row below.
4. In each role's Project, switch on only that role's relay connector and leave the others off. Check it in a thread: "Call whoami on the relay". It must name the Project's role.

| Connector | Token item | Switch on in |
|---|---|---|
| Relay · Orchestrator | Orchestrator token | the Orchestrator Project |
| Relay · Creative Director | Creative Director token | the Creative Director Project |
| Relay · Developer | Developer token | the Full-Stack Developer Project |
| Relay · James | Human token | your own chats only (optional: gates, status and the kill switch from any Claude app) |

### Claude Code

A role session started with `scripts/role-session.sh` (section 6) brings its own relay server, with that role's `Authorization: Bearer` header, through `--mcp-config`: don't add the relay to a role directory by hand as well (if you did earlier, `claude mcp remove relay` there).

For any other Claude Code session, e.g. your own with the human token:

```sh
claude mcp add --transport http relay https://<worker>/mcp --header "Authorization: Bearer <token>"
```

To keep the token out of your history, use `--header "Authorization: Bearer $(op read 'op://Agent Relay/Human token/password')"`. The default (local) scope stores the server for the current directory only. Never use `--scope project`: it writes the token into `.mcp.json`, which gets committed. Check with `claude mcp list`, or `/mcp` inside a session.

## 5. Project instructions

Append the shared protocol and the role's addendum to each Project's existing instructions. Keep the role's own instructions (its job, skills and connectors) as they are.

| Project | Append |
|---|---|
| Orchestrator | [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) + [`protocol/roles/orchestrator.md`](../protocol/roles/orchestrator.md) |
| Creative Director | [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) + [`protocol/roles/creative-director.md`](../protocol/roles/creative-director.md) |
| Full-Stack Developer | [`protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) + [`protocol/roles/developer.md`](../protocol/roles/developer.md) |

```sh
cat protocol/PROTOCOL.md protocol/roles/developer.md | pbcopy
```

- The Project instructions must hold the full text. The relay's MCP server instructions are only a short role-first digest, [`protocol/mcp/<role>.md`](../protocol/mcp/) (under 4 KB: every turn's steps, the routing rules, nudges, safety and the error codes), because clients may cut server instructions short (Claude Code keeps the first 4,096 characters). A redeploy updates the digest; after a change to `protocol/`, paste the Project instructions again.
- [`protocol/roles/human.md`](../protocol/roles/human.md) is for your own connector; the relay serves the human digest to the human token. Paste `PROTOCOL.md` and `human.md` only if you make a Project for relay control.
- A role run as a local Claude Code session (section 6, SPIKE.md Plan B) gets the protocol and its addendum from `scripts/role-session.sh`, appended to the system prompt at every start. Its directory's `CLAUDE.md` holds only the role Project's own instructions.

## 6. Mods and role sessions

Two Claude Code Mods ship in this repo's marketplace (`.claude-plugin/marketplace.json`):

- **relay-inbox**: the wake path. It polls the role's inbox, shows unread messages in a band above the prompt (with Read and Reply), hands them to the model with the next prompt and, with `auto_wake` on, starts a turn telling an idle session to check its inbox. See [`mods/relay-inbox/README.md`](../mods/relay-inbox/README.md).
- **relay-spike**: the milestone-1 spike ([`SPIKE.md`](SPIKE.md)). Remove it once the spike is done.

**Mod options are stored once per user and machine**, whatever scope a plugin is installed at and whatever directory or Project a session runs in: `relay_url` in the user settings, `role_token` in secure storage. A second install, or `/plugin configure`, replaces the token for every session on the machine. So one installed copy of relay-inbox serves exactly one role per machine, and:

- **Never install relay-inbox at user scope.** It would load in every session on the machine, hand that role's messages to whatever prompt is typed there (marking them read, so the real role session never sees them) and wake unrelated sessions.
- **Run one session per role at a time.** Two sessions with the same role race for its messages.
- **Install relay-spike only for the spike**, never next to role sessions or a rehearsal: every session that loads it can take wakes queued for its role. [`SPIKE.md`](SPIKE.md) says when and at which scope (`/plugin install relay-spike --marketplace jd-green/agent-relay`, the same steps as below), and to uninstall it afterwards.

### Several roles on one machine: `scripts/role-session.sh`

Don't install relay-inbox for this. Start each role with the launcher, which loads the Mod from this checkout for that one session:

```sh
export RELAY_URL=https://<worker>
scripts/role-session.sh orchestrator                      # in ~/relay-roles/orchestrator
scripts/role-session.sh creative-director --model sonnet  # in ~/relay-roles/creative-director
scripts/role-session.sh developer --dir ~/work/app        # another working directory, e.g. the app repo
scripts/role-session.sh developer -- --remote-control     # anything after -- goes to claude
```

- It takes the role's token from `<ROLE>_TOKEN` (e.g. `DEVELOPER_TOKEN`), else `RELAY_TOKEN`, else `op read` of `OP_REF_<ROLE>` (default `op://Agent Relay/<Role> token/password`, as in section 3; better, a service account's vault, below). Unless you pass `--no-check`, it asks the relay (`GET /api/me`) and refuses a token that is rejected or belongs to another role.
- It writes three files **outside the working directory**, in `${XDG_STATE_HOME:-~/.local/state}/agent-relay/<role>/` (directory mode 700, files mode 600, rewritten at every start): `.relay-inbox.json` (the Mod's options for this role, `{"pluginConfigs": {"relay-inbox": {"options": {"relay_url", "role_token", "auto_wake": true}}}}`), `.relay-mcp.json` (the relay MCP server with this role's `Authorization: Bearer` header) and `.relay-instructions.md` (`PROTOCOL.md` plus the role's addendum). Nothing is written into `--dir`, so an agent's `git add -A` there can't commit a token; copies an earlier version of the script left in `--dir` are deleted, with a warning. It refuses a state directory that sits in a git working tree that doesn't ignore the files.
- Then it runs, in `--dir`, `claude --plugin-dir <repo>/mods/relay-inbox --settings <state>/.relay-inbox.json --mcp-config <state>/.relay-mcp.json --append-system-prompt-file <state>/.relay-instructions.md` (absolute paths) with a first prompt, `Session started by scripts/role-session.sh: check your relay inbox and act per the relay protocol.` That first turn matters: function hooks are early access, and when the engine's rollout switch hasn't answered at startup it loads the hooks module only at the first turn start; until then an idle session neither polls nor wakes. With `--no-prompt`, send one prompt yourself. Either way, check that the `Relay · …` status line appears before leaving the session idle.
- The token is never printed or put on a command line. Before starting `claude` the script removes from its environment the relay token variables (`RELAY_TOKEN`, `ORCHESTRATOR_TOKEN`, `CREATIVE_DIRECTOR_TOKEN`, `DEVELOPER_TOKEN`, `HUMAN_TOKEN`), every `OP_*` variable (`OP_SESSION_<account>` from `op signin`, `OP_SERVICE_ACCOUNT_TOKEN`, `OP_CONNECT_TOKEN`, `OP_CONNECT_HOST`) and `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CF_API_TOKEN` and `CF_API_KEY`, so the agent's tools can't use `op` with your session or change the relay's secrets. Other variables pass through. `--dry-run` writes the files and prints the `claude` command instead of running it. `scripts/role-session.sh --help` lists every option.

### Threat model: role sessions under one OS user

The launcher keeps tokens off command lines, out of the environment and out of the working tree. That stops leaks; it is **no isolation**. Every session run as one OS user can do whatever that user can:

- read the other roles' token files (mode 600 doesn't stop the same user) and act as that role;
- run `op` through the 1Password app's CLI integration (an approval prompt, or a terminal you already authorized), use a `wrangler login` (`npx wrangler secret put HUMAN_TOKEN` makes anyone human; `npx wrangler tail` shows `/mcp/<token>` URLs), and read any file that holds the human token.

So:

- For real separation, run each role as its own OS user (or in its own container or VM), with its own clone of this repo and its own Claude Code login, and start it there: its state directory and `--dir` are then under that user's home.
- Never run role sessions under the account that holds `wrangler login` for the relay, or that can read the human token. Don't approve a 1Password prompt you didn't cause.
- Keep the role tokens in a vault of their own that holds only the three role items, never the human token, and let the launcher read them with a 1Password service account (if your plan has them) that can only read that vault:

  ```sh
  op vault create "Agent Relay Roles"
  export OP_REF_ORCHESTRATOR="op://Agent Relay Roles/Orchestrator token/password"
  export OP_REF_CREATIVE_DIRECTOR="op://Agent Relay Roles/Creative Director token/password"
  export OP_REF_DEVELOPER="op://Agent Relay Roles/Developer token/password"
  scripts/put-secrets.sh --generate orchestrator creative-director developer   # new tokens, made in that vault
  op service-account create "Agent Relay role sessions" --vault "Agent Relay Roles:read_items"
  ```

  The last command prints the service account's token once: keep it out of your shell history, e.g. in the macOS keychain (`security add-generic-password -a "$USER" -s "Agent Relay role sessions" -w`, which prompts for it). Then start role sessions with `OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -w -s "Agent Relay role sessions")"` in front of `scripts/role-session.sh <role>`, with the `OP_REF_<ROLE>` variables above set. The script reads the token with it, then removes it before `claude` starts. Delete the old role items from `Agent Relay` afterwards, and update the connector URLs (section 4).
- A role that needs a credential of its own (the developer's deploy token for the app) gets one scoped to that job and kept where only that role's user can read it, never a token for the relay's Cloudflare account. Since the launcher removes `CLOUDFLARE_API_TOKEN` and `OP_*`, don't rely on exporting it in the shell you launch from.

### One role on a machine: install

When a machine runs a single role, you can install relay-inbox there instead, at local scope in that role's directory. At a Claude Code prompt in that directory:

```
/plugin install relay-inbox --marketplace jd-green/agent-relay
```

Answer `y` to add the marketplace, choose the **local** scope, then fill in the settings. From a shell: `claude plugin install relay-inbox --marketplace jd-green/agent-relay --scope local` (the CLI's default scope is user). In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `jd-green/agent-relay` → **Add plugin**. While the repo is private, your machine needs a git credential for github.com (`gh auth login`, then `gh auth setup-git`). Don't start `role-session.sh` in a directory where relay-inbox is installed and enabled (or anywhere, if it is installed at user scope): two copies would load.

Settings (asked at install; the non-secret ones also appear in `/config`):

| Setting | relay-inbox | relay-spike | Value |
|---|---|---|---|
| `relay_url` | yes | yes | `https://<worker>`: the base URL, without `/mcp` (plain `http` only for `localhost` or `127.0.0.1`) |
| `role_token` | yes | yes | The token of the role this session plays (stored as a sensitive value) |
| `poll_seconds` | yes | yes | Seconds between polls: at least 15; defaults 60 (inbox) and 30 (spike) |
| `auto_wake` | yes | no | Start a "check your inbox" turn when new messages arrive and no turn is running (default on) |

To change them later: `/config` for the non-secret ones, `/plugin configure relay-inbox@agent-relay` in a session, or `echo '{"poll_seconds": 30}' | claude plugin configure relay-inbox@agent-relay --values-stdin` from a shell. `claude plugin configure` needs the full id, and without `--values-stdin` it only lists the options and which are unset.

## 7. Ledger page

Open `https://<worker>/` on your phone or desktop and paste the human token. Save it in 1Password as a login for that site so it autofills on the phone. The token stays in that browser's storage and is sent only to the relay; **Sign out** removes it.

The page shows every build's status, the current owner of each task, the last message and the pending gates with Approve and Reject buttons. It also has the escalations, the audit trail, **New build**, the kill switch (**Stop all agents**) and the spike view at `#spike`. Agent tokens can sign in too, but only the human token can decide gates or use the controls.

## 8. Kill switch and build controls

The kill switch stops every agent in every build at once. Every agent write (`send`, `ledger_update`, `gate_request`, `build_create`) fails with `halted`; `inbox` keeps answering with `halted.global: true`, so agents see it and stop; nudges pause. Your own token keeps working.

- Ledger page: **Stop all agents**, and **Turn off** in the banner.
- Your connector: ask Claude to turn the relay kill switch on, with a reason.
- curl, using `human_auth` from section 3:

  ```sh
  human_auth | curl -sS -H @- -H 'content-type: application/json' \
    -d '{"on": true, "reason": "runaway loop"}' "$RELAY_URL/api/call/kill_switch"
  human_auth | curl -sS -H @- -H 'content-type: application/json' \
    -d '{"on": false}' "$RELAY_URL/api/call/kill_switch"
  ```

Turning the kill switch off tells the orchestrator and the owner of every open task to carry on (a relay `status`, which also wakes sessions running relay-inbox).

Per build, `build_control` takes `halt`, `resume`, `cancel` or `set_caps`. `resume` and `cancel` tell the orchestrator and every open task's owner; `halt` sends nothing (agent writes answer `halted`). A build that reaches its message cap, or its ledger write cap (3 × `max_messages` agent `ledger_update` and `gate_request` calls), halts itself: raise the cap with `set_caps` (`caps.max_messages`), then `resume` (refused while the build is still at a cap). The ledger page offers both as **Raise cap and resume**. `set_caps` never leaves an open task fewer review rounds than the round it is in.

## 9. Configuration

`wrangler.jsonc` `vars` (all strings):

| Var | Default | Meaning |
|---|---|---|
| `HUMAN_NAME` | `James` | Display name of the `human` role |
| `NUDGE_AFTER_MINUTES` | `30` | Idle time before a nudge; also the gap before the second-miss escalation. Decimals allowed. |
| `MAX_MESSAGES_PER_BUILD` | `200` | Hard cap on agent-sent messages per build; three times it caps agent `ledger_update` and `gate_request` calls. Reaching either halts the build. |
| `MAX_REVIEW_ROUNDS` | `3` | Review rounds per task before escalation to the human |
| `BURST_PER_MINUTE` | `10` | Most messages one sender may send in one build in a rolling 60 s |
| `MAX_ACTIVE_BUILDS` | `1` | Builds not `shipped` or `cancelled` allowed at once |

Secrets: `ORCHESTRATOR_TOKEN`, `CREATIVE_DIRECTOR_TOKEN`, `DEVELOPER_TOKEN`, `HUMAN_TOKEN`: in `.dev.vars` locally, `wrangler secret put` (via `scripts/put-secrets.sh`) when deployed. `build_create` can set per-build gates and caps, and `build_control set_caps` can change the caps later. Only the human token may turn a gate off or raise a cap above these defaults; a build the orchestrator creates keeps both gates on and may only lower its caps.

`wrangler.jsonc` also keeps Workers Logs' invocation logs off (section 4); leave them off, since `/mcp/<token>` URLs carry role tokens.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Every call returns `401 unauthorized` after a deploy | Secrets missing or shorter than 32 characters (the role is disabled). Check `npx wrangler secret list` and re-run `scripts/put-secrets.sh`. |
| Every local call returns 401 | No `.dev.vars`, or the placeholders from `.dev.vars.example`. Run `node scripts/gen-dev-vars.mjs` and restart `npm run dev`. |
| One role returns 401 | Its token was rotated. Update that connector's URL and restart its role session (section 3, Rotate). |
| Claude Code reports `HTTP 404 dialing …/mcp…` (or `HTTP 405`), or claude.ai starts an OAuth sign-in for the relay | The relay answered 401, so the client tried OAuth, which the relay doesn't offer: the token in that connector URL or `Authorization` header is wrong or was rotated. The relay's 401 carries `WWW-Authenticate: Bearer … error="invalid_token", error_description="unknown or rotated relay token"`. Fix the token; a valid one never gets a 401. |
| A claude.ai connector won't connect | The URL must end in `/mcp/<token>` with nothing after it. Test the relay with the curl below. `GET /mcp` answers 405 by design (stateless JSON, no SSE); unknown paths answer 404. |
| Two Projects act as the same role | They share one connector. Add one connector per role (section 4). |
| `whoami` names the wrong role, or the relay's tools appear twice | More than one relay connector is switched on in that Project. Leave only its own. |
| `conflict` from `send` | Work messages are accepted only while the build is `in_progress`; a verdict needs the task `in_review`; a review request can't target a task that is `blocked`, `done`, `cancelled` or already `in_review` (one past the round budget is not refused: it escalates to you); an agent's `next_task_id` must be `todo`, and a done task's finishing handoff goes out once; nothing moves a task escalated to you until you decide its gate. `ledger_get` shows the state. |
| `forbidden` from `send` | A `review_request` must go to the task's reviewer, and only the task's owner (or the orchestrator) may send one. The orchestrator changes reviewers with `ledger_update`. An agent's handoff may name as `next_task_id` only a task that depends on its finished task or is already the recipient's. |
| `conflict` from `ledger_update` | A reviewer tried to change the status of a task in review (it answers with a verdict), the orchestrator set a task in review to anything but `cancelled`, marked a task `done` without an approved verdict for its current round, or changed the reviewer of a task that has been reviewed; or the build already has 100 tasks. |
| `invalid_input` from `ledger_update` | A field is wrong, a task is full (50 links or 50 notes), or `depends_on` would make a cycle. |
| `halted` | The kill switch is on or the build is halted. The ledger page shows which. |
| `cap_reached` | The build hit its message cap or its ledger write cap and halted. Raise `max_messages` with `set_caps`, then `resume`. |
| `rate_limited` | One sender went over `BURST_PER_MINUTE` messages, or `BURST_PER_MINUTE` × 3 `ledger_update` and `gate_request` calls, in a minute in one build. Wait a minute. |
| `secret_detected` | Something looked like a key or token, or was a role token. Send an `op://` reference instead. |
| Nudges never show up | Nudges apply only in `in_progress` builds while the kill switch is off, to `ready` tasks (every `depends_on` task `done`) that an agent holds, once both the task and the role it waits on have been idle for `NUDGE_AFTER_MINUTES`; any `send` or `ledger_update` by that role answers them. A task in review nudges its reviewer, or its assignee while the reviewer waits on the assignee's answer. A `blocked` task never nudges its owner: the orchestrator is told after `NUDGE_AFTER_MINUTES`, you after twice that. A role sees a nudge only when it next calls `inbox`, which is the wake problem [`SPIKE.md`](SPIKE.md) settles. |
| Port 8787 is busy | `npm run dev -- --port 8788`; use that port in the local URLs. |
| A Mod does nothing | Check `relay_url` and `role_token`. A freshly started session that nobody has typed into may not have loaded its hooks module yet: send one prompt (section 6). Run `claude --debug` and look for lines starting with the Mod's name; `hooks module … not loaded: … rollout switch` means the engine put off loading it until a turn starts, or function hooks are off on this machine. |
| Role sessions on one machine act as one role: messages vanish from a role's inbox, or the wrong session wakes | relay-inbox is installed, and its options (one set per machine) hold one role's token for every session. Uninstall it and start each role with `scripts/role-session.sh` (section 6). |
| `role-session: the token from … belongs to orchestrator, not developer` | The token variable or 1Password item holds another role's token, often a leftover `RELAY_TOKEN`. Unset it or fix the `OP_REF_<ROLE>` reference. |
| `role-session: … is inside a git working tree that doesn't ignore .relay-inbox.json` | The state directory (`$XDG_STATE_HOME`, or `~/.local/state`) is inside a git repository, e.g. a home directory kept in git. Set `XDG_STATE_HOME` to an absolute path outside it. |
| `role-session: … is not owned by <user>` | The state directory was made by another user (e.g. under `sudo`). Remove it, or set `XDG_STATE_HOME`. |
| In a role session, `op`, `wrangler` or a deploy can't find a credential that works in your shell | The launcher removes `OP_*` and the Cloudflare token variables on purpose (section 6, threat model). Give that role a credential of its own, scoped to its job. |
| A spike wake ran in the wrong session, or a headless run answered the wake instead of its prompt | The wake named no `session_id`, so the first session of that role to poll took it. Always pass `role` and `session_id`, and load relay-spike only in the sessions under test. |

MCP check with curl (lists the tools the human token may call):

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' "$RELAY_URL/mcp"
```
