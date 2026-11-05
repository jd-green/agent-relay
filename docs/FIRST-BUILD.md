# First live build: Reading Log

## Result

The live relay reached James's final sign-off gate, **G2**, on November 5, 2026 at 20:43:07 UTC (14:43 CT).

**G2 remains pending. This is not final acceptance or a claim that James signed off.**

- Ledger: https://agent-relay.dominion-equity.workers.dev/ — build `b-uare3wt47h`.
- App: https://empractica-control.tail0a9f28.ts.net:8830/app/ — tailnet access required; host must stay on.
- Source snapshot: [`examples/reading-log/`](../examples/reading-log/). These six files match the tested app by SHA-256.
- The Worker stayed on its existing deployment. This change does not alter or deploy it.

## Setup and gates

PR #2 merged as `115532e893beafbecd85f33335692ca5a8196d25`. The role checkout uses that commit. Each role runs Claude Code 2.1.318 with `claude-sonnet-5-5`, API billing and its own container, home, role token and relay session. The launcher supplies the full protocol and role addendum. James's existing claude.ai Projects stayed unchanged.

The host operator can control all containers. Their mounts expose no other role home, human token, host Docker socket or 1Password service account. This separates role files and credentials, not roles from the operator. It is not a hostile-network isolation audit. The host service account can read all four token items; it is not a role-scoped vault account. No service-account credential reaches a role process.

| Event | UTC | Evidence |
|---|---|---|
| Kickoff | Nov 4, 12:10:49 | Human kickoff M1 |
| Plan requested | Nov 4, 12:11:14 | G1; 24.7 seconds after kickoff |
| James approved plan | Nov 5, 20:25:44 | G1 decision, actor `human` |
| Design handoffs | Nov 5, 20:28:11–14 | M6: T1 → T3; M8: T2 → T4 |
| Log approved | Nov 5, 20:32:10 | M19; T3 round 1 |
| Add/Edit approved | Nov 5, 20:34:10 | M22; T4 round 1 |
| Ship approved | Nov 5, 20:42:08 | M34; T5 round 3 |
| Final sign-off requested | Nov 5, 20:43:07 | G2, pending |

Plan approval to G2 took **17 minutes 23 seconds**, including operator QA and fixes. The plan waited for James for **32 hours 14 minutes**. Do not count that wait as build time.

James had two decision gates. Max supplied setup repair and independent QA; this was **not an unaided three-role run**. Operator notes used the human credential but explicitly identified Max. Max made no gate decision.

## Defects and recovery

1. **Preview mount:** the nested design mount held an old, empty directory. Restarting only the preview container refreshed it. GETs then returned 200 from the host and developer container.
2. **Command format:** compound Bash mixed allowed `curl` with unlisted commands. The permission guard denied it. Plain `curl` worked without broader permissions. T3 briefly blocked; M12/M13/M18 resolved the false permission diagnosis.
3. **Silent storage failure:** real browser fault injection found that a failed localStorage write discarded edits without warning. M26/M27 sent it back. The developer propagated failed add/update/delete results and kept the form or confirmation open with an accessible error. Review round 2 found the new error text lacked the red style. Round 3 fixed that selector. Max reran browser checks and inspected the corrected states before M34 approved T5.

No relay nudges, stalled tasks or review escalations occurred. The ledger recorded 36 messages and 50 audit entries at G2. T5 used all three allowed review rounds.

## Verification

- **29/29 real Chrome checks passed** on the final app. Covered add, edit, cancel, delete confirmation, Keep/Escape, both filters, empty states, dates, newest-first order, unknown IDs and reload persistence.
- Quota-fault checks covered add, update and delete. They confirmed retained form data, visible alerts, unchanged stored data and successful retries.
- Browser requests stayed on the local app origin. No runtime exceptions appeared. QA removed its synthetic records afterward.
- Max visually inspected nine distinct mobile states at 360px and desktop list/edit at 1280px. Layout, text, controls and red error messages passed. The tailnet app returned HTTP 200.
- Relay: **241 unit assertions**, **36 script checks** and typecheck passed. Unit teardown still logs the known SQLite missing-table exceptions. Passing assertions do not establish clean teardown. Script checks used the real macOS temporary path.
- Snapshot regression: `node --test test/first-build/reading-log.test.mjs` — **3/3 passed**. This is a separate command, not part of `npm test`.

Evidence: [`test/first-build-evidence/`](../test/first-build-evidence/) holds the G2 ledger, before/after browser results, source hashes and cost estimate.

## Cost and limits

Model estimate at G2: **$3.48** across the three role sessions. This uses deduplicated transcript usage and list rates: $3/M input, $15/M output, $3.75/M cache writes and $0.30/M cache reads. It is not an invoice. The existing watcher stops role containers at $13, below the $15 trial cap. Idle HTTP polling adds no model inference.

The app is a static internal trial, not a public deployment. It has no account login or server-side data backup. Data stays in each browser; device/browser stores do not sync. Role reviews used source fetched with `curl`; Max supplied the missing browser QA. This trial does not prove subscription-account switching, cloud Project wake-up, phone behavior or unattended visual review.

## Handoff

G2 notice: https://discord.com/channels/1546161214479007834/1565010940754399232/1568002793921314979 . James must approve or reject G2 on the ledger. No approval occurred through this report.

The original three role sessions, preview and spend watcher remain up for that decision. Primary must review the exact snapshot and evidence, preserve James's gate, and stop the trial roles after sign-off or cancellation. Keep the preview available until James no longer needs it. Do not start a second build or redeploy the Worker as part of this handoff.
