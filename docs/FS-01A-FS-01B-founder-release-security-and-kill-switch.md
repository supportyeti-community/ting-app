# FS-01A + FS-01B — Founder release decisions and emergency order halt (17 November 2026)

## Founder architecture sign-off: standard RLS, deliberately not FORCE RLS
The Founder approved **ENABLE ROW LEVEL SECURITY without FORCE ROW LEVEL SECURITY** for all five new public tables: menu_categories, menu_allergen_codes, menu_item_allergen_reviews, menu_item_allergen_assessments, and menu_import_batches. Reason: approved SECURITY DEFINER RPCs/triggers execute with privileged table-owner rights while authenticated mutation entrypoints validate auth.uid(), routed tenant, and owner/admin membership. Regular anon/authenticated SQL paths remain subject to explicit table grants and RLS. Private trigger functions are not directly exposed to clients. This is an explicit architectural exception, not an omitted RLS control. Preserve native negative tests for anonymous, Floor, outsider and cross-tenant access.

## Deployment source exposure boundary
Root `.vercelignore` excludes supabase/, tests/, docs/, .github/, scripts/ and root *.sql from Vercel uploads. The Guest/Admin HTML, root browser JavaScript modules and api/ must remain deployable. The disposable native E2E runner is **not** proof of Vercel's deployed artifact contents. Before activating production, inspect the final Vercel deployment manifest or make unauthenticated HEAD/GET probes of /supabase/migrations/20261116000000_fs01a_menu_category_allergen_contract.sql, /supabase/baseline/native/fs01b.mjs, /tests/fs-01a-allergen-classification.mjs and /docs/FS-01A-menu-categories-allergen-contract.md; they must not expose files. Runtime /index.html, /admin.html, /fs01b-guest-allergy.js and /ting11b-cart.js must respond normally.

## Rollback kill-switch — server-side Guest ordering halt
The existing Admin offers individual is_out_of_stock toggles, **not** an adequate atomic venue-wide ordering kill-switch. A client-only maintenance banner is also insufficient: it can be bypassed by direct RPC calls. Until a dedicated approved server-side venue pause switch exists, the emergency control for this combined release is a *global temporary REVOKE of submit_order EXECUTE* from the public client roles. This halts new Guest ordering across all venues; service-ticket functionality and existing orders remain. It requires a separately approved privileged production SQL action, so it is a documented emergency procedure and **has not been executed**. Use it only when a global pause is justified; coordinate a venue-specific alternative if unaffected venues must stay open.

### Before activating the release
1. Inspect all public.submit_order overload signatures and their current PUBLIC, anon and authenticated EXECUTE privileges from pg_proc/pg_namespace/pg_roles; capture a signed evidence record with exact function signatures and role grants. Do not assume that only one signature exists.
2. Rehearse revoke → anonymous/normal-client denial → restoration using those *captured* grants on disposable Supabase. Verify that historical orders are preserved and the existing order-status read interfaces remain available.
3. Prepare a reviewed, exact-signature emergency transaction. An illustration of the action for a discovered exact signature is:

```sql
BEGIN;
REVOKE EXECUTE ON FUNCTION public.submit_order(<EXACT ARGUMENT TYPES FROM pg_proc>)
  FROM PUBLIC, anon, authenticated;
COMMIT;
```

The placeholder is intentional: **never execute** this snippet until the exact signature is verified in production. A server-side deny should be validated by an anonymous `has_function_privilege` and a non-mutating permission test, not by placing a real order.
4. Restore only the previously captured privileges, under explicit Founder authorization, after a safe Guest experience is verified. Do not indiscriminately grant PUBLIC or broaden any privilege. Note: PostgreSQL grants may be inherited, and Supabase function grants can vary by signature. Capture and review every path before declaring the switch reliable.

### Emergency sequence
- Stop Vercel traffic to the broken release if needed, and immediately execute the separately approved exact-signature order halt. An app rollback **alone is not safety-compliant** because the prior Guest app lacks selected-allergy enforcement.
- Verify the halt, preserve expanded schema, assessments, orders and migration ledger; restore previously verified application code only behind the server-side halt.
- Diagnose and apply a forward correction; unpause only after Guest filtering, assessments and submit_order authorization are reverified and the Founder approves resumption.

## Remaining release gates
Combined PR #51 must remain unmerged into main. No production database writes or Vercel production deployments under this sign-off. The production-grade backup / isolated restore and final executable emergency halt proof remain separate release gates. FS-01A/FS-01B are a single Founder-approved *design* boundary, not production release authorization.
