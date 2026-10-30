# Agent Relay

Cross-project agent collaboration for Claude Projects. A small remote MCP server (Cloudflare Workers + Durable Objects) lets role agents in separate Claude Projects hand work to each other, track it in a shared ledger, and loop James in only at chosen gates.

**Status:** the v1 relay is built: MCP server, ledger, typed messages, review loop, nudges, loop caps, kill switch, ledger page, the inbox and spike Mods, and the protocol snippet. The relay is deployed. The wake-up spike (milestone 1) is complete for Max-accessible surfaces: **Plan B** (local Claude Code role sessions) is the chosen path. Hooks, marker injection, idle wakes and queued wakes after resume passed; the hourly cloud task also ran unattended, outside a Project. Test plugins/tasks are removed. Evidence, cloud limits and untested device rows are in [`docs/SPIKE.md`](docs/SPIKE.md#results).

- PRD: [`docs/PRD.md`](docs/PRD.md) (source: Claude artifact "Agent Relay — Cross-Project Agent Collaboration PRD", Oct 28, 2026)
- Design contract: [`docs/DESIGN.md`](docs/DESIGN.md)
- Setup, deploy and connectors: [`docs/SETUP.md`](docs/SETUP.md)
- Spike runbook: [`docs/SPIKE.md`](docs/SPIKE.md)
- Protocol snippet for the role Projects: [`protocol/`](protocol/)

## v1 scope

One loop end to end: Orchestrator, Creative Director and Full-Stack Developer ship one small web app from a single kickoff, with at most two human touchpoints (plan approval, final sign-off).

## What's here

| Path | What it is |
|---|---|
| `src/` | The Worker: MCP server, JSON API, spike endpoints, and the `RelayDO` and `BuildDO` Durable Objects |
| `src/ui/ledger.html` | The ledger page served at `/`: builds, owners, gates, kill switch, spike view |
| `protocol/` | `PROTOCOL.md`, pasted into every role Project, one addendum per role in `roles/`, and in `mcp/` the short role digests the relay serves as MCP instructions |
| `mods/` | Claude Code Mods: `relay-inbox` (wake path and inbox band) and `relay-spike` (milestone 1) |
| `scripts/` | `gen-dev-vars.mjs` (local tokens), `put-secrets.sh` (1Password to Wrangler secrets) and `role-session.sh` (starts a local Claude Code session as one role, for Plan B) |
| `test/` | Unit tests (`unit/`), end-to-end tests (`e2e/`) and live agent tests (`live/`) |
| `docs/` | PRD, design contract, setup guide, spike runbook |

## Quick start

```sh
npm ci
node scripts/gen-dev-vars.mjs   # local role tokens in .dev.vars
npm run dev                     # relay on http://127.0.0.1:8787, ledger page at /
npm test
```

To deploy, connect the role Projects and set up the Mods, follow [`docs/SETUP.md`](docs/SETUP.md). To run a role as a local Claude Code session (one per role, several on one machine):

```sh
export RELAY_URL=https://<worker>
scripts/role-session.sh developer   # token via op read; see SETUP §6
```

Role sessions run as one OS user can read each other's tokens: see the threat model in SETUP §6.

Live checks with real Claude sessions (they cost model usage) are described in [`test/live/README.md`](test/live/README.md).

## Milestones

1. Spike: wake-up and Mods
2. Relay and ledger
3. Protocol snippet
4. Review loop
5. Orchestrator plus nudges
6. End-to-end build
7. Native polish (Mod)

## Rules

- No secrets in the repo. Use 1Password and `op read`; Wrangler secrets for deployed Workers.
- Deploy only from a pushed commit.
