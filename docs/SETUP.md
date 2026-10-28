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
   printf 'https://%s/mcp/%s' "<worker>" "$(op read 'op://Agent Relay/Developer token/password')" | pbcopy
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
scripts/role-session.sh developer --dir ~/work/app        # a role directory of your choice
scripts/role-session.sh developer -- --remote-control     # anything after -- goes to claude
```

- It takes the role's token from `<ROLE>_TOKEN` (e.g. `DEVELOPER_TOKEN`), else `RELAY_TOKEN`, else `op read` of `OP_REF_<ROLE>` (default `op://Agent Relay/<Role> token/password`, as in section 3). Unless you pass `--no-check`, it asks the relay (`GET /api/me`) and refuses a token that is rejected or belongs to another role.
- It writes three files into the role directory with mode 600, rewritten at every start: `.relay-inbox.json` (the Mod's options for this role, `{"pluginConfigs": {"relay-inbox": {"options": {"relay_url", "role_token", "auto_wake": true}}}}`), `.relay-mcp.json` (the relay MCP server with this role's `Authorization: Bearer` header) and `.relay-instructions.md` (`PROTOCOL.md` plus the role's addendum). Keep them out of git; the script warns when the directory is in a repository that doesn't ignore them.
- Then it runs, in that directory, `claude --plugin-dir <repo>/mods/relay-inbox --settings .relay-inbox.json --mcp-config .relay-mcp.json --append-system-prompt-file .relay-instructions.md` with a first prompt, `Session started by scripts/role-session.sh: check your relay inbox and act per the relay protocol.` That first turn matters: function hooks are early access, and when the engine's rollout switch hasn't answered at startup it loads the hooks module only at the first turn start; until then an idle session neither polls nor wakes. With `--no-prompt`, send one prompt yourself. Either way, check that the `Relay · …` status line appears before leaving the session idle.
- The token is never printed, put on a command line or left in the session's environment. `--dry-run` writes the files and prints the `claude` command instead of running it. `scripts/role-session.sh --help` lists every option.

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

Per build, `build_control` takes `halt`, `resume`, `cancel` or `set_caps`. `resume` and `cancel` tell the orchestrator and every open task's owner; `halt` sends nothing (agent writes answer `halted`). A build that reaches its message cap halts itself: raise the cap with `set_caps` (`caps.max_messages`), then `resume`. The ledger page offers both as **Raise cap and resume**.

## 9. Configuration

`wrangler.jsonc` `vars` (all strings):

| Var | Default | Meaning |
|---|---|---|
| `HUMAN_NAME` | `James` | Display name of the `human` role |
| `NUDGE_AFTER_MINUTES` | `30` | Idle time before a nudge; also the gap before the second-miss escalation. Decimals allowed. |
| `MAX_MESSAGES_PER_BUILD` | `200` | Hard cap on agent-sent messages per build. Reaching it halts the build. |
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
| `conflict` from `send` | Work messages are accepted only while the build is `in_progress`; a verdict needs the task `in_review`; a review request can't target a task that is `blocked`, `done`, `cancelled` or already `in_review`, or one out of review rounds; nothing moves a task escalated to you until you decide its gate. `ledger_get` shows the state. |
| `forbidden` from `send` | A `review_request` must go to the task's reviewer, and only the task's owner (or the orchestrator) may send one. The orchestrator changes reviewers with `ledger_update`. |
| `conflict` from `ledger_update` | A reviewer tried to change the status of a task in review (it answers with a verdict), the orchestrator marked a task `done` without an approved verdict for its current round, or changed the reviewer mid-review. |
| `halted` | The kill switch is on or the build is halted. The ledger page shows which. |
| `cap_reached` | The build hit its message cap and halted. Use `set_caps`, then `resume`. |
| `rate_limited` | One sender went over `BURST_PER_MINUTE` messages, or `BURST_PER_MINUTE` × 3 `ledger_update` and `gate_request` calls, in a minute in one build. Wait a minute. |
| `secret_detected` | Something looked like a key or token, or was a role token. Send an `op://` reference instead. |
| Nudges never show up | Nudges apply only in `in_progress` builds while the kill switch is off, to `ready` tasks (every `depends_on` task closed) that an agent owns, once both the task and its owner have been idle for `NUDGE_AFTER_MINUTES`; any `send` or `ledger_update` by the owner answers them. A role sees a nudge only when it next calls `inbox`, which is the wake problem [`SPIKE.md`](SPIKE.md) settles. |
| Port 8787 is busy | `npm run dev -- --port 8788`; use that port in the local URLs. |
| A Mod does nothing | Check `relay_url` and `role_token`. A freshly started session that nobody has typed into may not have loaded its hooks module yet: send one prompt (section 6). Run `claude --debug` and look for lines starting with the Mod's name; `hooks module … not loaded: … rollout switch` means the engine put off loading it until a turn starts, or function hooks are off on this machine. |
| Role sessions on one machine act as one role: messages vanish from a role's inbox, or the wrong session wakes | relay-inbox is installed, and its options (one set per machine) hold one role's token for every session. Uninstall it and start each role with `scripts/role-session.sh` (section 6). |
| `role-session: the token from … belongs to orchestrator, not developer` | The token variable or 1Password item holds another role's token, often a leftover `RELAY_TOKEN`. Unset it or fix the `OP_REF_<ROLE>` reference. |
| A spike wake ran in the wrong session, or a headless run answered the wake instead of its prompt | The wake named no `session_id`, so the first session of that role to poll took it. Always pass `role` and `session_id`, and load relay-spike only in the sessions under test. |

MCP check with curl (lists the tools the human token may call):

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' "$RELAY_URL/mcp"
```
