# Agent Relay

Cross-project agent collaboration for Claude Projects. A small remote MCP server (Cloudflare Workers + Durable Objects) lets role agents in separate Claude Projects hand work to each other, track it in a shared ledger, and loop James in only at chosen gates.

**Status:** initialized, no implementation yet. The first milestone is the wake-up / Mods spike.

- PRD: [`docs/PRD.md`](docs/PRD.md) (source: Claude artifact "Agent Relay — Cross-Project Agent Collaboration PRD", Oct 28, 2026)

## v1 scope

One loop end to end: Orchestrator, Creative Director and Full-Stack Developer ship one small web app from a single kickoff, with at most two human touchpoints (plan approval, final sign-off).

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
