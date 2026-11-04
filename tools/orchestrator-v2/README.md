# TinG Orchestrator v2 — control-plane prototype

**Status: PROTOTYPE / NO EXECUTION DISPATCH.** This branch adds a deterministic selection protocol and a state-transition contract; it does not install an autonomous coding agent, schedule jobs, change production, or connect to live Notion/GitHub mutations.

## Why this first

Monitoring already exists. The missing safety primitive is an exclusive, durable work claim. Starting multiple coding agents without it could duplicate work and create conflicting branches.

## Contract

- Input: a validated snapshot of authoritative Notion work items mapped into the documented task shape. Snapshot extraction and provenance checking are **not yet implemented**.
- Only tasks explicitly marked `ready`, `low` risk, approval-free, unowned, and whose dependencies are `done` are eligible.
- Selection is stable by priority then ID.
- Claim uses a version + state + owner compare-and-swap. A real adapter MUST make this atomic in durable storage; a read-followed-by-write is NOT sufficient.
- A worker may move its own claim only to `review` with an evidence URL. Neither the worker nor this prototype auto-merges or marks tasks `done`.
- Unknown dependencies, malformed records, stale versions, occupied claims or mismatched owners fail closed.
- No automatic production migrations, secret changes, Stripe activation, deployment, or payment UI availability.

## Run tests

```sh
node --test tools/orchestrator-v2/core.test.mjs
```

## Not implemented (required before an autonomous pilot)

1. Notion canonical-record extraction, schema mapping, last-edited/version provenance and explicit stale-state resolution.
2. **Durable atomic claim adapter** with scoped credentials and a lease/fencing-token strategy. The in-memory test double is not a distributed lock.
3. Branch/PR ownership and overlap detection; task/branch uniqueness.
4. Isolated coding-worker dispatch, resource budgets, CI, failure retries and interruption recovery.
5. Audited evidence writeback, safe release of claims, approval gates, and coordinator deployment.
6. End-to-end adversarial tests using real connector/CI integration and a disposable environment.

No release or production authority is implied by passing these unit tests. This is intentionally a small first PR for review rather than an unreviewed orchestrator rollout.


## GitHub-backed claim controller (added)

The prototype now includes a runnable GitHub API adapter and a scheduled **read-only** audit workflow. It recognises only GitHub issues marked `orchestrator:ready`, `orchestrator:low-risk`, `orchestrator:approved` with a validated `orchestrator-task` JSON fence. Currently the only permitted `kind` is `repo-audit`. Issue dependencies must be both closed and labelled `orchestrator:verified`. Unknown states fail closed.

A manually invoked `claim` operation can create `refs/heads/orch-claims/issue-N`. GitHub ref creation is atomic: only one concurrent claimant can create a given ref. Claim markers persist across restarts and are *not* automatically reclaimed. A 422 duplicate-ref response is a conflict, not success. The claim operation makes no code changes, creates no PR and dispatches no worker.

Example task issue body (documentation only; this is not a currently authorised work item):

```orchestrator-task
{"kind":"repo-audit","workItemId":"TING-100","notionUrl":"https://app.notion.com/p/REPLACE","dependencies":[],"risk":"low","approvalRequired":false}
```

New files: `github-controller.mjs`, `github-controller.test.mjs`, `run.mjs` and `.github/workflows/orchestrator-v2-controller.yml`. The existing `orchestrator-v2.yml` now runs both suites. GitHub Actions uses only its built-in token with read-only permissions for audit and scoped contents write for an **explicitly manually dispatched** claim. The scheduled audit will not operate until this draft PR is reviewed and merged into main.

**Limitations before autonomy:** A GitHub issue `notionUrl` is not yet cross-verified against canonical Notion. Do not allow automated work claiming based on mirrored records until canonical extraction and a durable synchronized authority contract are implemented. There is no autonomous coding worker, claim expiry/fencing/recovery, automatic evidence writeback or permission-bounded task dispatcher yet. A persistent claim is not a finished task. No production mutation, Stripe action, payment release, or unattended coding is possible through this prototype.
