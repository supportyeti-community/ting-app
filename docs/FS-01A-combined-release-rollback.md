# FS-01A — Compensation and combined-release boundary (2026-11-16)

## Release boundary (founder-approved)
FS-01A **must ship together with FS-01B**, not separately. Draft PR #51 remains unmerged. Do not activate allergen selected-order restrictions before the bulk CSV/Excel menu import, mapping, draft saving and authorised dish review path are available and rehearsed. Do not mutate any connected Supabase or production Vercel deployment until a separately evidenced founder release approval.

## Safe operational rollback (preferred)
Before activating the combined release, maintain a backwards-compatible application path. If the new category/allergen/CSV experience fails after migration, disable new UI/guest enforcement and restore the previously verified code. **Leave the expanded database columns/tables and all dish reviews intact.** This is a feature/traffic rollback, not a schema rollback; retain records and migrate forward to correct defects. Do not interpret an unreviewed dish as safe or bypass the approved warning/block rule in an active allergy-filtered experience. Pause ordering or route guests to staff if accurate safety information cannot be served.

## Destructive schema compensation — only if proven unused
The accompanying [review-only SQL script](./sql/FS-01A_compensating_reversion_REVIEW_ONLY.sql) is a **contingency proposal**, not a committed future Supabase migration. It begins a transaction and refuses to proceed if any categories, assigned categories, assessments, reviewed recipe/preparation context or noninitial safety versions exist. It drops only FS-01A functions/triggers/tables/column without CASCADE, and preserves historic menu and order tables. PostgreSQL RESTRICT stops unexpected dependent objects. It must be rehearsed against a full, isolated reconstructed deployment and reviewed separately. **Never delete migration ledger entries**, even if the schema is compensated; apply a newly numbered forward correction with approvals instead.

## Combined release sequencing
1. Keep PR #51 in draft; do not apply any connected migration.
2. FS-01B: parse CSV/XLSX locally; map columns; preview/repair; validate prices/duplicates/categories; atomic tenant-scoped, idempotent batch commit; save all newly imported dish assessments as unverified.
3. Admin: edit category and dish, record separate allergen states and recipe/preparation, verify authorised versioned review with clear invalidation.
4. Guest: show categories, optional multiple-allergy selection, conflicts/cross-contact/unknown flagged and normal add-to-cart disabled with Ask Staff. An allergy filter must never fall back to unsafe free-form tags.
5. Rehearse native migration/import + Guest/Admin integration + order regressions, bad inputs, wrong-tenant replay, concurrency, idempotency and rollback/recovery. Confirm existing dishes remain browseable as Uncategorised until explicit assignment.
6. Founder-reviewed combined approval: isolated verified migration(s), backup/restore proof, final review, linked PR diffs and operational readiness. Stage compatible schema before activating UI, then enable guest filtering only after venue assessments/import workflow ready.
7. Hold payment release, PR merge and production until specifically approved.

## 403 governance
PR #52 proposes changing `.github/workflows/parallel-pr-safety.yml` to `pull-requests: write` (retaining `issues: write`). PR-safety runs as `pull_request_target` from default branch; this change **cannot correct current PR #51 check before it is merged**, and no merge was authorised. Existing `issues: write` already covers the comment endpoint, so repository/organisation policy may still cause 403. Do not mark check green without a successful post-change execution.

## Evidence
- [FS-01A PR #51](https://github.com/supportyeti-community/ting-app/pull/51)
- [Native Postgres 17.6/Supabase CLI 2.117.0 PASS, run 43820300308](https://github.com/supportyeti-community/ting-app/actions/runs/43820300308)
- [CI permission proposal PR #52](https://github.com/supportyeti-community/ting-app/pull/52)
- [Finish Sprint authority](https://app.notion.com/p/41927a72067381ec95ecc1584316ae38)
