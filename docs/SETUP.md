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
- Local Claude Code session against the local relay: `claude mcp add --transport http relay-dev http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token from .dev.vars>"`.

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

**Rotate** a token whenever its URL may have leaked: `scripts/put-secrets.sh --generate <role>`, then update that role's connector URL (section 4), its Claude Code header and its Mod's `role_token`.

**Change a setting** (section 9): edit `vars` in `wrangler.jsonc`, commit, push, deploy.

## 4. Connect the roles: one connector per role

Custom connectors belong to your claude.ai account, not to a Project; a Project can only switch on connectors from your account's list. One connector has one URL and so one token, which would give every Project the same identity. So connect the relay **once per role**. This differs from the PRD's "the relay is added once as a custom connector": the relay is deployed once and connected four times.

### claude.ai Projects (desktop app and web)

Connector URL: `https://<worker>/mcp/<role-token>`

The token goes in the path because claude.ai custom connectors may not send custom headers; the relay accepts the last path segment of `/mcp/<token>` as the token. The trade-off: the URL itself is now the secret. It can appear in logs (including Cloudflare's request logs, since the Worker has observability on), browser history and screenshots. Keep it in 1Password, never paste it into a message (the relay rejects any role token with `secret_detected`), and rotate the token if it leaks.

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

```sh
claude mcp add --transport http relay https://<worker>/mcp --header "Authorization: Bearer <token>"
```

To keep the token out of your history, use `--header "Authorization: Bearer $(op read 'op://Agent Relay/Developer token/password')"`. The default (local) scope stores the server for the current directory only, which is what you want when each role runs in its own directory. Never use `--scope project`: it writes the token into `.mcp.json`, which gets committed. Check with `claude mcp list`, or `/mcp` inside a session.

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

- The relay also sends this same text (protocol plus the caller's addendum) as its MCP server instructions, so a client that shows server instructions sees it twice. That is harmless, and it means a redeploy updates what connected roles get even before you re-paste.
- [`protocol/roles/human.md`](../protocol/roles/human.md) is for your own connector. The relay serves it to the human token; paste it only if you make a Project for relay control.
- For a role run as a local Claude Code session (SPIKE.md, Plan B), put the same text in that directory's `CLAUDE.md`.

## 6. Mods

Two Claude Code Mods ship in this repo's marketplace (`.claude-plugin/marketplace.json`):

- **relay-inbox**: the wake path. It polls the role's inbox, shows unread messages in a band above the prompt (with Read and Reply), hands them to the model on the next turn and, with `auto_wake` on, starts a turn telling an idle session to check its inbox.
- **relay-spike**: the milestone-1 spike ([`SPIKE.md`](SPIKE.md)). Uninstall it once the spike is done.

Install at a Claude Code prompt:

```
/plugin install relay-inbox --marketplace jd-green/agent-relay
/plugin install relay-spike --marketplace jd-green/agent-relay
```

From a shell: `claude plugin install relay-inbox --marketplace jd-green/agent-relay`. In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `jd-green/agent-relay` → **Add plugin**. Answer `y` to add the marketplace, pick a scope, then fill in the settings. While the repo is private, your machine needs a git credential for github.com (`gh auth login`, then `gh auth setup-git`).

Settings (asked at install; the non-secret ones also appear in `/config`):

| Setting | relay-inbox | relay-spike | Value |
|---|---|---|---|
| `relay_url` | yes | yes | `https://<worker>`: the base URL, without `/mcp` |
| `role_token` | yes | yes | The token of the role this session plays (stored as a sensitive value) |
| `poll_seconds` | yes | yes | Seconds between polls: at least 15; defaults 60 (inbox) and 30 (spike) |
| `auto_wake` | yes | no | Start a "check your inbox" turn when new messages arrive and no turn is running (default on) |

A session polls as the role whose token its Mod holds. To run several roles on one machine, install relay-inbox separately in each role's directory (local scope) with that role's token, rather than once at user scope.

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

Per build, `build_control` takes `halt`, `resume`, `cancel` or `set_caps`. A build that reaches its message cap halts itself: raise the cap with `set_caps` (`caps.max_messages`), then `resume`.

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

Secrets: `ORCHESTRATOR_TOKEN`, `CREATIVE_DIRECTOR_TOKEN`, `DEVELOPER_TOKEN`, `HUMAN_TOKEN`: in `.dev.vars` locally, `wrangler secret put` (via `scripts/put-secrets.sh`) when deployed. `build_create` can set per-build caps, and `build_control set_caps` can change them later.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Every call returns `401 unauthorized` after a deploy | Secrets missing or shorter than 32 characters (the role is disabled). Check `npx wrangler secret list` and re-run `scripts/put-secrets.sh`. |
| Every local call returns 401 | No `.dev.vars`, or the placeholders from `.dev.vars.example`. Run `node scripts/gen-dev-vars.mjs` and restart `npm run dev`. |
| One role returns 401 | Its token was rotated. Update that connector's URL, Claude Code header and Mod `role_token`. |
| A claude.ai connector won't connect | The URL must end in `/mcp/<token>` with nothing after it. Test the relay with the curl below. `GET /mcp` answers 405 by design (stateless JSON, no SSE). |
| Two Projects act as the same role | They share one connector. Add one connector per role (section 4). |
| `whoami` names the wrong role, or the relay's tools appear twice | More than one relay connector is switched on in that Project. Leave only its own. |
| `conflict` from `send` | Work messages are accepted only while the build is `in_progress`; a verdict needs the task `in_review`; a review request can't target a `blocked`, `done` or `cancelled` task. `ledger_get` shows the state. |
| `halted` | The kill switch is on or the build is halted. The ledger page shows which. |
| `cap_reached` | The build hit its message cap and halted. Use `set_caps`, then `resume`. |
| `rate_limited` | One sender went over `BURST_PER_MINUTE`. Wait a minute. |
| `secret_detected` | Something looked like a key or token, or was a role token. Send an `op://` reference instead. |
| Nudges never show up | Nudges apply only to `in_progress` builds, to tasks an agent owns, and while the kill switch is off. A role sees a nudge only when it next calls `inbox`, which is the wake problem [`SPIKE.md`](SPIKE.md) settles. |
| Port 8787 is busy | `npm run dev -- --port 8788`; use that port in the local URLs. |
| A Mod does nothing | Check `relay_url` and `role_token`. Run `claude --debug` and look for lines starting with the Mod's name. |

MCP check with curl (lists the tools the human token may call):

```sh
human_auth | curl -sS -H @- -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' "$RELAY_URL/mcp"
```
