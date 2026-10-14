# TinG Repository Audit — 2026-10-14

Scope: non-destructive audit of branches, PRs, docs, issues, CI, repository structure and payment work. No historical branch or file was deleted or renamed during this audit.

## Executive result

The repository is operationally healthy enough to continue PAY-2 sandbox work, but repository governance is under-specified. The largest governance gaps are the absence of a repository README/operating guide, no PR template, no standalone GitHub Issues, and an unprotected `main` branch as reported by the branch listing. Historical branches are numerous but are evidence-bearing and were retained.

## Authority used

- TinG Product OS: current sequence is Ordering → Payments → D-Day reliability/security hardening → first real venue; reliability/security outrank novelty; financial truth stays deterministic/server-authoritative.
- TinG Engineering Handbook: canonical engineering databases hold work items, architecture, changes/deployments, test specifications, verification runs and evidence.
- GitHub: executable truth for code, migrations, branches, PRs and releases.

## Branches

Before this audit branch was created, GitHub listed 28 branches: `main` plus 27 non-main branches.

Only `pay2-stripe-sandbox` has an open pull request (#25). The remaining non-main branches are historical or merged-work candidates, including PAY-1, ordering, password-lifecycle, storage and TING-2 slices. Several branches clearly map to merged PRs, but branch deletion was not performed because merge status alone is not sufficient proof of deletion safety.

The three `ops/ting-2-*production-rollout` branches are especially important to retain until comparison and release-document references prove they are dispensable; historical PR text describes one-use rollout workflows being retired, but that is not enough on its own to delete their Git refs.

Audit action: retain all existing branches. Use the deletion gate in `docs/REPOSITORY-GOVERNANCE.md` for any later cleanup.

## Pull requests

- PR #23 — PAY-1 split-aware payment foundation: merged.
- PR #24 — PAY-1 hardening: merged into current `main` at `ba4e0cac2621cec79188be25e8f21380a8ef4be6`.
- PR #25 — PAY-2 Stripe Connect sandbox direct-charge adapter: open and mergeable at audit time, head `59d5728320764b465eeaeddf21db27690ee336ce`.
- No other open PR was found.

The PR history contains strong implementation/release evidence, but future PRs need a consistent minimum structure so critical security, production/config and verification facts are not dependent on author memory.

## Issues and work tracking

GitHub search returned no standalone Issues. This is not automatically a defect because the TinG Engineering Handbook declares the Notion canonical Issues & Work Items database authoritative for engineering orchestration.

Governance implication: PRs should reference the canonical engineering work item where one exists. GitHub Issues should not be introduced as a competing backlog unless an explicit workflow decision is made.

## CI

The repository contains focused workflows for baseline restore, tenant isolation, storage, password lifecycle, ordering slices and payment foundation.

On PAY-2 head `59d5728320764b465eeaeddf21db27690ee336ce`, the following pull-request workflow runs completed successfully:

- PAY-2 Stripe sandbox
- PAY-1 payment foundation
- TING-11 ordering foundation
- TING-2 tenant isolation
- TinG native baseline restore
- TING-4 Storage listing

Vercel status on the same head was successful.

Risk: branch listing reports `main` as unprotected. The current GitHub integration cannot read/change branch-protection settings because administration access is not exposed. Protection must therefore be verified and enabled in GitHub settings by an authorized administrator.

## Repository structure

The default branch is a deliberately small vanilla/static application with server/database support rather than a framework-heavy monorepo. Major surfaces are:

- guest shell: `index.html`
- admin shell: `admin.html`
- authentication surfaces: `auth.html`, `reset-password.html`
- ordering modules: `ting11b-cart.js`, `ting11c-order-board.js`
- database history/recovery: `supabase/`
- tests: `tests/`
- CI: `.github/workflows/`
- engineering/design evidence: `docs/`

The root-level historical `TING-9-DEPLOYMENT-AND-ROLLBACK.md` and review documents under `docs/` were retained. Their location may be aesthetically inconsistent, but historical evidence should not be moved merely for tidiness.

## Current payment work

PAY-1 on `main` implements the split-aware internal payment foundation: one order can have multiple payment attempts/allocations; pending attempts reserve payable balance; browser writes do not become authoritative financial truth; idempotency and tenant/order coupling are enforced. PAY-1 hardening changed the public balance wrapper to SECURITY INVOKER and added the payment-allocation covering index.

PAY-2 is sandbox/test-mode Stripe Connect work using direct charges with a server-resolved connected account per tenant. It introduces the provider mapping/state boundary, create-intent endpoint, verified Connect webhook handling, provider idempotency, test/live guards and disposable native rehearsal. The PR states that no Stripe secrets are committed, no production PAY-2 migration has been applied, and no real/test payment has yet been created through the implementation.

The design is aligned with the Product OS requirement for server-authoritative financial truth, retry safety, reconciliation and processor abstraction. It is not production-ready merely because CI is green. Sandbox environment configuration, real sandbox acceptance, webhook/retry/reconciliation failure-path evidence and explicit production gates remain separate work.

## Changes implemented by this audit

Additive governance changes only:

1. `README.md` — repository map, authority model and engineering rules.
2. `docs/REPOSITORY-GOVERNANCE.md` — branch/file retention policy, PR minimum, CI/release rules and branch-protection target.
3. `docs/REPOSITORY-AUDIT-2026-10-14.md` — this evidence snapshot.
4. `.github/PULL_REQUEST_TEMPLATE.md` — consistent engineering/release evidence prompts.

No production code, SQL, CI workflow, payment implementation, historical file or pre-existing branch was modified.

## Recommended next governance actions

1. Review and merge the governance PR after its own diff is checked.
2. Enable/verify `main` branch protection in GitHub settings with PR and required-check enforcement.
3. After PAY-2 is resolved, perform a separate branch-retirement pass using Git comparisons and reference checks; do not mix that deletion decision into active payment work.
4. Keep the Notion Engineering Handbook databases canonical for work items/evidence and make PRs reference them rather than creating a second backlog accidentally.