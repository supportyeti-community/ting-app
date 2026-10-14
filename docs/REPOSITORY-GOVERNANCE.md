# TinG Repository Governance

This document defines repository hygiene rules consistent with the TinG Product OS and TinG Engineering Handbook.

## Authority

- Product scope, sequencing and product decisions come from the TinG Product OS.
- Engineering workflow, architecture, verification and implementation evidence come from the TinG Engineering Handbook.
- GitHub is executable truth for code, migrations, branches, PRs and releases.
- Runtime/configuration truth must be reconciled into engineering records when it materially differs from Git.

## Branch model

- `main` is the production/release integration branch.
- New work should use short-lived, purpose-specific branches.
- One branch should map to one bounded engineering outcome wherever practical.
- Do not reuse historical release branches for unrelated new work.
- Open PRs should identify their Product OS/Engineering Handbook work item or explain why the change is pure repository maintenance.

## Historical branch retention and deletion gate

Historical branches are evidence until proven otherwise. Do not delete a branch merely because its PR is merged.

A historical branch may be considered safe to delete only when all of the following are proven:

1. No open PR targets or originates from the branch.
2. Its intended PR is merged or formally abandoned with preserved rationale.
3. Git comparison proves the branch contains no commits that are uniquely required and absent from the canonical successor history.
4. It is not referenced by an active deployment, rollback, recovery, migration-reconciliation or certification procedure.
5. Any durable implementation evidence has been reconciled into canonical documentation.
6. Deletion has no effect on an active preview/sandbox workflow that is still being used for acceptance.

If any point is uncertain, keep the branch.

## Files and documentation

- Do not rename or remove historical review/release files solely to make the tree prettier.
- Current design docs may evolve; historical evidence docs should remain immutable except for factual corrections or explicit supersession notes.
- A document that becomes obsolete should normally receive a clear status/supersession note before deletion is considered.
- Migration filenames are part of deployment history. Never rename an applied migration unless the sole purpose is explicit ledger reconciliation and SQL bytes/semantics are verified.

## Pull-request minimum

Every non-trivial PR should state:

- scope and intended outcome;
- authority/work item;
- tenant/security impact;
- database/migration impact;
- production/configuration impact;
- tests/CI run and results;
- manual acceptance evidence still required;
- rollback/recovery considerations;
- whether the change is safe to merge now.

Payment PRs must additionally state the money-movement boundary, idempotency behavior, reconciliation path, provider mode (sandbox/live), secret/config requirements and whether any real payment or production provider mutation occurred.

## CI and release discipline

- Security/isolation regressions remain required when a change can affect tenant boundaries.
- Database changes require disposable restore/forward/retry rehearsal appropriate to their risk.
- A green feature workflow does not replace the baseline, tenant-isolation or relevant cross-layer workflows.
- Production certification must be distinguished from preview/sandbox certification.
- Out-of-Git changes to Supabase, Vercel or payment-provider configuration must be recorded in the Engineering Handbook evidence/deployment records.

## `main` protection target

`main` should be protected through GitHub repository settings with, at minimum:

- pull request required before merge;
- required status checks for the relevant baseline/security workflows;
- stale approvals dismissed or re-review required after material head changes where available;
- force pushes and deletion disabled;
- direct pushes restricted to exceptional recovery use.

Repository settings are not represented by this document; verify actual GitHub protection state separately.

## Cleanup cadence

Repository cleanup should be evidence-driven, not cosmetic. A periodic cleanup pass should:

1. list open PRs and active branches;
2. identify merged historical branches as candidates only;
3. compare candidate branches against canonical history before deletion;
4. review stale design docs for supersession labels rather than deletion;
5. reconcile current payment/order work with Product OS and Engineering Handbook;
6. verify CI workflows still match current release risks;
7. verify `main` protection and release governance are actually enabled.