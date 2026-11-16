# TinG Finish Sprint — FS-01A → FS-01B technical handoff (2026-11-16)

> **Authoritative handoff for a NEW FS-01B thread.** Preserve code and evidence. No production deployment, connected migration, protected merge, payment activation or paid infrastructure authorised.

## New founder-approved release decision
**Ship FS-01A and FS-01B as ONE staged combined release.** Keep draft [PR #51](https://github.com/supportyeti-community/ting-app/pull/51) unmerged and the connected Supabase project unchanged. Do not enforce selected-allergen guest ordering restrictions before CSV/Excel import, category editing and authorised allergen review are ready and rehearsed. Once activated, unknown/unverified/conflicting selections must NOT be represented as safe or bypassed. Deployment approval is a separate future decision.

## Canonical authority
- [Unified Finish Sprint](https://app.notion.com/p/41927a72067381ec95ecc1584316ae38)
- [Approved Guest/Floor/Admin UI/UX](https://app.notion.com/p/41927a72067381a8b060cb90a3ec2558)
- [Product OS](https://app.notion.com/p/3f927a72067381919fd7e7ff47e2b958)
- [Product Decision Log](https://app.notion.com/p/3f927a720673813ba7eef709739faf4d)
- [Roadmap](https://app.notion.com/p/3f927a720673815f87bcc43ba6ca988a)
- [Engineering Handbook](https://app.notion.com/p/3ac27a7206738114bf5fe3cf3fd715c2)
- Repo: https://github.com/supportyeti-community/ting-app; issues #45 and #49 remain open.

## FS-01A contract state
- **PR:** #51, branch `fs-01a-menu-allergen-contract`, draft and unmerged.
- **Base main inspected:** `931216a696ef28de0cc693836aa7f4d2f354ae56` (refresh before next implementation; never assume unchanged).
- **Proposed SQL:** `supabase/migrations/20261116000000_fs01a_menu_category_allergen_contract.sql`. The exact SQL is in the GitHub PR branch, not applied to any connected Supabase environment.
- **Schema:** `menu_categories` with tenant-owned ordered identities; `menu_items.category_id` nullable with composite tenant/category FK; `menu_allergen_codes` seeded with 23 controlled codes; `menu_item_allergen_assessments` storing contains/may_contain/assessed_absent/unknown; `menu_item_allergen_reviews` storing safety_version, verified_version, reviewer ID and timestamp, private recipe and preparation context.
- **RPCs:** `set_menu_item_allergen(p_item_id,p_code,p_state,p_evidence_note,p_expected_version)`, `set_menu_item_safety_context(p_item_id,p_recipe,p_preparation,p_expected_version)`, `verify_menu_item_allergens(p_item_id,p_expected_version)`, `get_menu_allergen_status()`. Reviewer identity derives from auth and membership; database invalidation triggers handle description/assessment changes. Guest status RPC is tenant-routed and excludes internal notes.
- **Governance:** only owner/admin verified membership may manage safety details; Floor has no broad menu/category/verification writes. Guest data never owns tenant/prices/reviewer. Preserve `submit_order`, tenant header `x-client-slug`, order snapshots and existing table capability security.
- **Uncategorised:** existing menu items are retained and must be shown in an Uncategorised group; do not delete, hide or silently force a category for legacy dishes.
- **Safety policy approved 16 Nov:** when a guest selects any allergy, `contains`, `may_contain`, unknown/missing or non-current verification must display a warning, disable normal add-to-cart and offer Ask Staff. Assessed absence is not a guarantee. No automatic coeliac-safe claims, no import-based verification, no automatic staff override.
- **Existing UI is NOT yet integrated.** Schema contract-ready is not released capability.

## Proven evidence
- [FS-01A native CI run #43820300308](https://github.com/supportyeti-community/ting-app/actions/runs/43820300308): PASS on `2ca40fcb9694a7c467c239461951ea0a86639a95` before later documentation-only commits. Native PostgreSQL 17.6, Supabase CLI 2.117.0, 7/7 model checks, migration dry-run/apply/ledger/repeat, native RLS/grant checks, wrong-tenant and Floor denials, owner safety review, invalidation and stale concurrent write fencing, historical order snapshot preservation. Cleanup PASS; production_writes=0. Revalidate branch HEAD after any change.
- Read-only connected Supabase project `okrwklulwrfnrhnffbwp` (SupportYeti TMS) still lacked FS-01A schema as of 16 Nov. Exclude PAY-2 sandbox. No paid Supabase dev branch created.
- Other PRs: #47 modifies shared native `run.mjs`; FS-01A deliberately isolates runner as `run-fs01a.mjs` to avoid direct conflict.
- PR safety check: 403 on GitHub PR issue-comment POST. [Draft PR #52](https://github.com/supportyeti-community/ting-app/pull/52) proposes `pull-requests: write` in `.github/workflows/parallel-pr-safety.yml` (retains `issues: write`). Because `pull_request_target` uses base `main`, #52 cannot certify/fix #51 until separately approved and merged; no such merge is authorised. The existing `issues:write` permission was already present, so a repository/org permissions restriction may be the true underlying problem. Do not report CI green without proof. No need for `checks:write` or `statuses:write` in this workflow.

## Exact FS-01A file inventory
`.github/workflows/fs01a-native.yml`
`docs/FS-01A-menu-categories-allergen-contract.md`
`docs/FS-01A-combined-release-rollback.md`
`docs/sql/FS-01A_compensating_reversion_REVIEW_ONLY.sql` (review-only, NEVER auto-applied)
`supabase/baseline/native/fs01a.mjs`
`supabase/baseline/native/run-fs01a.mjs`
`supabase/migrations/20261116000000_fs01a_menu_category_allergen_contract.sql`
`supabase/tests/fs01a/menu-allergen-contract.sql`
`tests/fs-01a-allergen-classification.mjs`

## Rollback contract
- Preferred: roll back Guest/Admin/import feature activation and restore the last verified application while **preserving the expanded schema and dish review data**. For allergy-specific uncertainty provide staff enquiry or pause related ordering rather than declaring unknown dishes safe.
- The standalone review-only SQL compensation script guards against ANY category rows, assigned category IDs, any allergen assessments, noninitial review versions or review context; if data exists it ABORTS and requires a separate data-preserving forward correction. No `DROP CASCADE`; don't manipulate migration ledger. Do not use it before backup/recovery evidence and explicit approval.

## Next task: FS-01B — bulk menu import
**Goal:** minimum functional, audited CSV/Excel ingestion → column mapping → preview/correction → validation → server-side batch save as draft → explicit allergen review. Manual edits remain available. No PDF/photo/OCR, paid services, or speculative import AI.

**Entry:** read fresh canonical Notion requirements and GitHub PR #51; inspect existing Admin create/edit, menu table and new proposed schema. Keep PR #51 draft; do not make changes to connected Supabase. Build FS-01B on an isolated non-production branch with an explicit integration path back to the category/allergen contract (avoid merging PR #51 to main).

**Required implementation contract:**
1. Spreadsheet parsing CSV and .xlsx: inspect current dependencies; select safe/no-paid maintained parser; constrain file size, row count, MIME/content, formulas/macros and malicious CSV/Excel input, protect against formula injection in exported corrections; never execute spreadsheet formulas.
2. Map columns for category, dish name, description, AUD price (strict decimal), available/out-of-stock, optional image URL, import row identifier, optional draft allergen evidence; require user review, don't infer allergens as verified.
3. Preview and repair with row-level errors, duplicate detection (in-file and against existing tenant menu), deterministic sort order, safe Unicode/case normalisation, useful empty/error/success states.
4. Server-side tenant and owner/admin authority using membership; independent validation (client preview is untrusted); accept resolved category IDs or create validated tenant-owned categories atomically; ensure `menu_items` ownership immutable, price authoritative and old menu items untouched unless explicit reconcile.
5. Batch idempotency: `tenant_id + import_request_id` unique with payload digest; same key/same digest returns same saved item IDs, same key/different digest rejects; concurrency and ambiguous retries must not duplicate dishes; failure must be atomic with a truthful per-row error result.
6. Save **draft/unverified**; imported tags or imported 'gluten-free' claims never set review metadata or `assessed_absent`. Route to Admin Edit Dish allergen review using the FS-01A versioned RPCs.
7. UI inside venue onboarding Menu → Allergens step; preserve manual add/edit; no fake persistence. A full 100-row fixture including bad prices, wrong-tenant, duplicates, stale retries and partial failure must be tested.
8. Native disposable migration/import tests + real REST Auth/RLS adversarial + UI and ordering regression. Legacy Uncategorised remains visible. No loss of F4 Floor 86/Restore capability.
9. Integration/release: first validate the FS-01A migration and FS-01B workflow together in a disposable environment, then independent security PR review, backup/recovery proof and explicit founder gate for a **combined release**. Keep runtime filtering off until Admin import/allergen verification workflows are operational. Do not weaken the approved warning/block semantics when enabling.

**Update after work:** FS-01B section of Finish Sprint, issue #45 or dedicated scoped issue if warranted, PR/evidence refs, precise files/schema/security/test outcomes, blockers/rollout holds, roadmap if verified, Product Decision Log only for truly new approved decisions. No production or payment changes; preserve immutable historical migrations.

## Strong stop conditions
No PR merges, connected DB data/schema writes, Vercel production deploy, paid compute, secret/auth changes, PAY-2 activation, broad Floor permissions, new architecture or unsafe guest allergy bypass. Only request founder approval at a real protected boundary, with exact action/resources/diff/risks/recovery and evidence.
