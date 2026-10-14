# TinG Branch Retirement Ledger — 2026-10-14

This ledger records branch-retirement evidence without deleting any Git refs. It follows `docs/REPOSITORY-GOVERNANCE.md`: historical branches are retained until deletion safety is proven.

## Current integration baseline

- `main`: `d460c27ad19caac83d415adcdefd1b32853d213a`
- Governance PR #26 is merged.
- PAY-2 PR #25 remains the active payment-development PR.

## Active — retain

### `pay2-stripe-sandbox`

**Classification:** ACTIVE / RETAIN

Evidence against current `main`:

- status: diverged
- ahead: 24 commits
- behind: 5 commits
- merge base: `ba4e0cac2621cec79188be25e8f21380a8ef4be6`
- open PR: #25 — PAY-2 Stripe Connect sandbox direct-charge adapter

This branch contains the current Stripe Connect sandbox implementation and must not be retired while PAY-2 is active.

## Retirement-ready by ancestry — deletion not executed

The following branches were directly compared against current `main`. Each returned `ahead_by: 0`, proving that the branch head contributes no commit absent from `main`.

| Branch | Behind current `main` | Evidence classification |
| --- | ---: | --- |
| `chore/ting-5-database-baseline` | 162 | Fully contained |
| `feat/ting2-route-scope-registry` | 140 | Fully contained |
| `feat/ting2-routing-registry-prepare` | 144 | Fully contained |
| `fix/ting-2-customer-entry-feedback` | 158 | Fully contained |
| `fix/ting-2-menu-events-isolation` | 153 | Fully contained |
| `fix/ting-2-menu-item-isolation` | 155 | Fully contained |
| `payments-v1-design` | 10 | Fully contained; PAY-1 PR #23 merged |
| `pay1-hardening` | 6 | Fully contained; PAY-1 PR #24 merged |
| `ting10-password-lifecycle` | 63 | Fully contained |
| `ting11-migration-version-reconcile` | 42 | Fully contained |
| `ting11-ordering-v1` | 50 | Fully contained |
| `ting11b-customer-cart` | 27 | Fully contained |
| `ting11c-order-board` | 21 | Fully contained |
| `ting11d-ordering-certification` | 18 | Fully contained |
| `ting6-harden-sanitize-search-path` | 112 | Fully contained |
| `ting8-admin-membership-gate` | 116 | Fully contained |

### Decision

These branches have passed the **Git ancestry** part of the deletion gate. They are candidates for later retirement, not authorization to delete them immediately.

Before deletion, still confirm:

1. no active deployment/preview depends on the ref;
2. no rollback or recovery procedure names the branch as an operational input;
3. durable evidence is preserved in merged PRs, current code and canonical documentation;
4. branch deletion capability is intentionally exercised in a dedicated cleanup operation.

## Retain pending additional proof

The following historical branches were deliberately **not** cleared for retirement in this pass because they are rollout/release/review sensitive or have not yet received the same direct ancestry/reference check:

- `fix/ting-2-service-ticket-authorization`
- `fix/ting-2-settings-table-isolation`
- `ops/ting-2-events-production-rollout`
- `ops/ting-2-menu-production-rollout`
- `ops/ting-2-production-rollout`
- `review/ting2-closure`
- `ting4-release-ledger-align`
- `ting-4-storage-listing`
- `ting-4-storage-membership`
- `ting-4-tenant-path-contract`

The `ops/` branches are especially sensitive because historical release records describe one-use production rollout workflows. Even if their commits are later shown to be contained in `main`, operational/reference checks should be explicit before removing the refs.

## Governance branch created during this audit

- `chore/repository-governance-audit` was merged through PR #26. Its branch head is historical after merge, but this ledger does not retire it automatically.
- `chore/branch-retirement-ledger` is the branch carrying this evidence document and remains active until its PR is resolved.

## Recommended next action

Do **not** mix historical branch deletion into PAY-2 implementation. Merge this ledger as documentation, keep PAY-2 focused, and perform actual Git-ref retirement only in a dedicated cleanup pass after PAY-2 is resolved or at a deliberate maintenance checkpoint.
