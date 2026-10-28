# Agent Relay — Cross-Project Agent Collaboration PRD

Oct 28, 2026 · Light-duty draft · Author: James Green

> Copied from the Claude artifact `ApyP5Rx4GBWiT2pykJE4GY`. Diagrams are summarized in text.

## Problem and goal

Role agents I've defined as Claude Projects can't hand work to each other, so I'm the router between every step. Each Project already holds a role (instructions, connectors, skills), for example a Creative Director. Threads inside one Project can message each other, but nothing lets a thread in one Project start a conversation with a thread in another.

**Goal:** I describe a build once ("build an app that does X"). Role agents in separate Projects then carry it to done on their own: they design, build, review and iterate, and loop me in only at gates I choose.

**Success looks like:** one kickoff message produces a reviewed, deployed v1 of a small app with at most two human touchpoints.

## Scope

v1 proves one loop end to end: Orchestrator, Creative Director and Full-Stack Developer ship one small web app.

### In v1

- Three roles, each in its own existing Claude Project, unchanged apart from a shared protocol snippet
- A relay that lets any role post to and read from any other role
- A shared work ledger: tasks, owners, status, artifacts, review verdicts
- A review loop between Developer and Creative Director with an iteration cap
- Human gates at kickoff approval and final sign-off

### Not in v1

- More than one concurrent build
- Roles beyond the three above (QA, copywriter and others come in v2)
- Reverse-engineering Claude Desktop internals; v1 uses only supported surfaces (connectors, Mods, Claude Code)
- A custom UI beyond what a Mod and the ledger page give

## Roles

Each role is a Claude Project. Its instructions define the job, and its connectors and skills define what it can touch.

| Role | Owns | Hands off | Done when |
|---|---|---|---|
| Orchestrator | The brief, the plan, the ledger, nudges, escalation to me | Tasks to whoever owns the next step | Every task is closed and I've signed off |
| Creative Director | UI direction, screens, design system, visual review | Design spec plus artifact links to Developer; review verdicts | It approves the build against its spec |
| Full-Stack Developer | Code, repo, deploys, preview URLs | Preview URL plus a change summary to Creative Director | Build approved and deployed |
| Me (James) | The kickoff brief, gate approvals, tie-breaks | Answers at gates | Final sign-off |

## Core workflow

A build moves through four roles and loops only between Developer and Creative Director. I'm needed at two gates.

1. Kickoff brief (James, one message)
2. Orchestrator plans and opens the ledger → **gate: James approves the plan**
3. Creative Director designs the UI and hands off
4. Developer builds and posts a preview URL
5. Creative Director reviews the preview
   - No → change list back to Developer (step 4)
   - After 3 rounds, the Orchestrator escalates to James
   - Yes → continue
6. **Final sign-off (gate: James)**
7. Shipped: deployed v1

The Orchestrator tracks every step in the ledger and nudges idle owners after 30 minutes. Every arrow is a typed relay message, and every box updates the ledger. The Orchestrator doesn't sit in the path; it watches the ledger and nudges whoever owns the next step.

## Requirements

### Functional

- **Addressing.** Any role can send a message to another role by name, such as `creative-director`. It doesn't need to know thread IDs.
- **Typed messages.** Every message has a type (`task`, `handoff`, `review_request`, `verdict`, `question`, `status`), a build ID, a sender role and links to artifacts. Free text alone isn't enough for the Orchestrator to track state.
- **Ledger as source of truth.** Tasks, owners, statuses and review verdicts live in one store that every role reads and writes. Messages point at ledger items; they don't replace them.
- **Delivery to the right thread.** A message to a role lands in that role's active thread for the build, and that thread is created if none exists.
- **Wake-up.** The receiving role acts within minutes without a human prompt. This is the hardest requirement; see Open questions.
- **Review loop.** A verdict is either `approved` or `changes_requested` with a numbered list of changes. After 3 rounds the Orchestrator escalates to me.
- **Nudges.** The Orchestrator re-pings an owner whose task sits idle for 30 minutes, and escalates to me after a second miss.
- **Human gates.** The build pauses at configurable gates (plan approval, final sign-off) until I answer, from my phone if needed.
- **Visible state.** I can see every build's status, the current owner and the last message in one place without opening each Project.

### Non-functional

- **Security:** bearer-token auth per role; roles can't impersonate each other; no secrets in message bodies.
- **Loop safety:** a per-build cap on messages and iterations, and a kill switch that stops all roles at once.
- **Auditability:** every message and state change is logged with a timestamp and sender.
- **Cost:** v1 runs on Cloudflare's free or near-free tiers.

## Architecture

A small remote MCP server is the only new infrastructure. Everything else uses supported Claude surfaces.

- **Role Projects, one thread per build:** Orchestrator (plans, tracks, nudges), Creative Director (designs, reviews), Full-Stack Developer (builds, deploys). Each Project loads the relay connector, the protocol snippet and the inbox Mod, and posts/reads over MCP.
- **Relay: remote MCP server on Cloudflare Workers**
  - Router: addresses roles by name; typed messages, loop caps
  - Work ledger: tasks, owners, verdicts; audit log of every message
  - Nudger: pings idle owners at 30 min; escalates to James
- **James:** approves gates, breaks ties
- **Ledger page:** every build's status; gate approvals from phone
- **Wake path (spike decides):** A: Mod injects on next turn. B: local Claude Code sessions.

Components:

- **Relay (Workers + Durable Objects):** one Durable Object per build holds its messages and ledger. MCP tools: `send(to_role, type, body, links)`, `inbox(role, since)`, `ledger_get(build)`, `ledger_update(task, status)`.
- **Connector:** the relay is added once as a custom connector, and each role Project enables it.
- **Protocol snippet:** a shared block in every Project's instructions covering message types, "check your inbox at the start of each turn," and how to hand off.
- **Inbox Mod (if the spike confirms):** injects unread messages at turn start and shows an inbox band plus a Reply button in the Code tab.
- **Ledger page:** an artifact backed by the relay, showing build status and the gate approve/reject buttons.
- **Wake path:** chosen by the spike. Plan A is a Mod plus a wake trigger. Plan B runs each role as a local Claude Code session loaded with its Project's instructions, where native cross-session messaging already wakes idle sessions.

## Open questions and risks

The build depends on one question: can something outside a Project thread wake it up? Everything else is standard engineering.

| Question or risk | Why it matters | How to settle it |
|---|---|---|
| Do Mod hooks fire in Project threads (cloud sessions), and which events? | Decides whether inbound messages can be injected automatically | Day-1 spike: an event-logging Mod posting to a test Worker |
| Can anything start a turn in an idle thread? | Without it, a role acts only when someone prompts it, which breaks autonomy | Same spike; also test scheduled tasks and a phone/Remote Control prompt |
| Fallback if threads can't be woken | The design needs a plan B | Each role runs as a local or background Claude Code session with its Project's instructions; native cross-session messaging wakes them |
| Runaway loops between Developer and Creative Director | Cost and noise | Iteration cap, message budget per build, kill switch |
| Artifacts the other role can't see (Figma file, preview URL, repo) | Review fails silently | Every handoff carries links the receiver can open; the spike checks connector access per role |
| Projects is still beta | Behavior can change under me | Use only supported surfaces; keep protocol logic in the relay, not in Project internals |

## Milestones and success metrics

1. **Spike: wake-up and Mods.** Exit when I know whether Project threads can be woken and receive injected context, or the fallback is chosen.
2. **Relay and ledger.** A remote MCP server is live, and two Projects exchange typed messages that the ledger records. Exit when a manual handoff round-trips.
3. **Protocol snippet.** A shared block for every role's Project instructions covering message types, when to check in, and how to hand off. Exit when each role follows it unprompted in a test.
4. **Review loop.** Developer and Creative Director iterate on one screen without me. Exit when an approved verdict closes the task.
5. **Orchestrator plus nudges.** Exit when a stalled task gets nudged and then escalated.
6. **End-to-end build.** Exit when one small app ships from a single kickoff.
7. **Native polish (Mod).** An inbox band, a Reply button and ledger status in the Code tab.

### Success metrics

- Human touchpoints per build: 2 or fewer (kickoff approval, final sign-off)
- Kickoff to deployed v1: under one day for a small app
- Stalled tasks that I had to notice myself: 0
- Review rounds per screen: 3 or fewer
