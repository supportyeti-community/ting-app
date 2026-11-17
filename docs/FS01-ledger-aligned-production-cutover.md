# FS-01 combined production release — ledger-aligned staging authority (2026-11-17)

## Contract and Founder authority

FS-01A and FS-01B are one combined forward-only schema/application release. Founder approved repository-side reconciliation and use of the production-linked Supabase CLI after **exact-two** dry-run and prerequisite check; no production `migration repair`, `--include-all`, baseline replay, historical ledger manipulation, PAY-2 execution or unrelated migrations. Founder approved standard ENABLE RLS without FORCE RLS on the five new tables. App restoration is schema-compatible; a safety rollback must halt Guest ordering until selected-allergen protections are available.

**Do not execute `supabase db push --linked` from the repository's raw `supabase/migrations` directory.** It is not in sync with the production ledger. Use the dynamically generated ephemeral overlay from `scripts/fs01-stage-migrations.mjs` and the two-phase gated workflows.

## Production migration ledger audit

Read-only production project: `okrwklulwrfnrhnffbwp` (SupportYeti TMS). Database migration ledger as inspected 17 Nov 2026: **27 already-applied versions**.

### Six remote-applied versions absent in repository migrations

| Applied production ledger version | Production name | Repository local-only analogous migration |
| --- | --- | --- |
| 20261008111104 | pay1_payment_foundation | 20261008110500_pay1_payment_foundation.sql |
| 20261008111706 | pay1_hardening | 20261008112000_pay1_hardening.sql |
| 20261014191710 | ting11_table_access_context | 20261015000000_ting11_table_access_context.sql |
| 20261014193154 | ting11_service_ticket_table_context | 20261015010000_ting11_service_ticket_table_context.sql |
| 20261030122153 | ops1_orders_realtime | 20261030084000_ops1_orders_realtime.sql |
| 20261031221339 | ting11_cap1_table_capability_lifecycle | 20261031113000_ting11_cap1_table_capability_lifecycle.sql |

These six relationships are mapped by stable migration **name/purpose**, not by a matching raw SQL MD5. Do not claim the source files are byte-identical to the historical production statement arrays or replay them. The production ledger is authoritative for what has been applied.

### Other local-only migrations excluded from FS-01

- `20261015020000_pay2_current_main_recovery.sql`
- `20261031104500_pay2_unbound_confirmation_account_check.sql`

Both are PAY-2 work and remain **HOLD**; they are NOT part of this cutover.

### Repository source fingerprints and staging

The ledger-overlay builder records every repository-local SQL filename, rejects duplicate versions, checks each source candidate against production ledger statement MD5 when available, and reports unmatched files. Its initial run found 15 exact raw-SQL matches and 12 already-applied ledger-only placeholders; **the placeholders are not authoritative historical SQL, and must never be used for fresh database reconstruction or sent as future unapplied migrations.** The nine ancient baseline source entries are protected by the separate canonical `supabase/baseline/migration-history.json` fingerprints.

The temporary overlay contains 27 already-applied version records plus exactly:
- `20261116000000_fs01a_menu_category_allergen_contract.sql` (SHA256 `197d985951489a98d2f728fb8cb0513c59621881c9d5b3add8a7cd4267960ff0`)
- `20261117000000_fs01b_bulk_menu_draft_import.sql` (SHA256 `d55c74d4080b1814f24aa10b76a9be93428ccc2fd0eb3ab2709c371563733244`)

The two forward SQL files are copied unchanged, from the Git revision. After the throwaway CLI workdir is destroyed, the canonical repository remains unmodified.

## Evidence / release gates

- [Original raw-directory preflight STOP](https://github.com/supportyeti-community/ting-app/actions/runs/43989946478).
- [Isolated production ledger-aligned exact-two dry-run PASS](https://github.com/supportyeti-community/ting-app/actions/runs/43994680201). Output includes `LEDGER_ALIGNMENT=PASS applied=27 pending_exactly_2=true` and `EXACT_FS01_DRY_RUN=PASS count=2 production_writes=0`.
- Production read-only catalogue confirmed `public.tenants`, `menu_items`, `orders`, `order_items`, `tenant_memberships`, `ting_private.request_tenant_id()`, `ting_private.can_manage_tenant()`; new FS-01 public tables and migration ledger versions absent before release.
- The emergency all-signatures `submit_order` temporary privilege halt/rollback rehearsal PASS: [disposable run 43989409667](https://github.com/supportyeti-community/ting-app/actions/runs/43989409667).
- **Backup limitation:** Supabase project organization is on Free plan; automatic daily backups and PITR are not included. Neither this overlay nor application backward compatibility establishes production recovery proof. Do not claim database recoverability certified without an independent restorable backup.
- [Combined release PR #51](https://github.com/supportyeti-community/ting-app/pull/51): merge to main only after both migrations are proven applied and production schema postconditions PASS.
- PAY-2 remains HOLD.

## Operational rule after release

When the FS-01 migrations become applied, this *pre-release-only* overlay manifest and its exact-two-pending assert are consumed historical evidence, not a reusable `db push` workflow. Future migrations require a newly audited ledger-aware checkout and change-specific exact pending list; do not keep stale pre-release execution workflows enabled for later changes. No history or ledger rewrite.
