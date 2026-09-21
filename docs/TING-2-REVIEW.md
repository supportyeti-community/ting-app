# TING-2: settings and table-link isolation — review draft

## Decision and live evidence

This is the first bounded release within TING-2, not closure of TING-2 or a
claim of complete TinG isolation. The canonical handbook selects TING-2 as P0:
https://app.notion.com/3b527a72067381079a53e9aa51c10fae
ADR-006 requires UUID ownership, membership authorization and no fallback tenant:
https://app.notion.com/3b427a720673813e94efdfcd2a1e51bb

Read-only inspection on 18 September 2026 confirmed main at
586950f1c3c5ae7948a2aa19e23e80f1e2a8628d, merged PR #2, zero settings rows,
zero table links, zero memberships, nullable ownership, a table-link primary key
without tenant_id, broad public SELECT and global is_admin() write policies.
The request_tenant_id resolver was absent. No production test writes were made.
Notion's issue query returned stale TING-5 In progress; direct page fetch and
merged PR confirm Done. The direct page is authoritative for that discrepancy.

## Changes and access contract

- Settings: required tenant UUID; at most one settings row per tenant.
- Table links: required UUID and composite (tenant_id, source_table, target_table)
  key, so two restaurants can use identical table numbers without conflict.
- Both: ownership cannot change on UPDATE, including for users in both tenants.
- Anonymous visitors can read public restaurant branding for a known explicit
  x-client-slug. This is public routing, not identity or write authorization.
  Missing, malformed or unknown routing returns no settings and a null resolver.
- Authenticated owners/admins can manage rows only for their database membership.
  A global admin_users row, a forged slug/header or editable JWT metadata does
  not grant access. Other membership roles have no management access in this
  slice. Provisioning membership remains a trusted operator action.
- Table links are private: no anonymous SELECT; no client TRUNCATE/DDL privileges.
- The request UUID RPC is SECURITY INVOKER. Its private SECURITY DEFINER lookup
  intentionally supports anonymous public routing and returns only one UUID.
  The private membership helper checks auth.uid(), uses a locked search_path,
  and has narrowly granted EXECUTE. Existing private trigger functions retain
  their non-client ACLs when schema USAGE is granted.
- Both tables leave the Postgres Changes publication. Realtime DELETE does not
  apply RLS to deleted rows, so even client-side channel filters are insufficient
  as the authorization boundary. Table links refresh immediately after local
  writes, and every ten seconds for other sessions; logout stops the timer.
  Settings had no frontend subscription. Existing menu/ticket subscriptions are
  outside this slice and remain a broader isolation risk.
- Both pages resolve the UUID before scoped operations. The admin missing-client
  fallback is removed. Table-link upserts explicitly supply the tenant and key.

Relevant current platform guidance:
https://supabase.com/docs/guides/database/postgres/row-level-security
https://supabase.com/docs/guides/realtime/postgres-changes#receiving-old-records
The current changelog was inspected; explicit grants accommodate the changed
Data API default grants. No relevant dependency upgrade is included.

## Table classification and remaining TING-2 scope

| Table | Classification | Remaining boundary |
| --- | --- | --- |
| restaurant_settings | Tenant-owned public branding | This release |
| table_configurations | Tenant-owned private operational links | This release |
| menu_items | Tenant-owned public menu | Required ownership and membership writes remain |
| menu_events | Tenant-owned analytics | Required ownership, related-item consistency and membership access remain |
| service_tickets | Tenant-owned operations | Ownership exists; membership reads/writes remain |
| tenants | Platform tenant registry | Trusted operator-managed, no client direct grants |
| tenant_memberships | Platform authorization registry | Trusted provisioning; no client enrollment |
| restaurant_clients | Platform public routing registry | Broad global-admin mutation remains to harden |
| admin_users | Legacy platform allowlist | Existing remaining policies depend on it; no new use |

Storage isolation is TING-4; broader programme work is TING-8. TING-6 and TING-7
advisor warnings remain unchanged. Global authorization on other tables means
this draft must NOT be treated as permission to onboard a second live tenant.

## Tests

Local PostgreSQL-engine tests reproduce the old cross-tenant write, check
unowned and duplicate-row migration rollback/retry, both directions of member
CRUD, cross-tenant mutations, missing ownership, conflicting table-number
upserts, ownership reassignment even for dual members, global-allowlist denial,
forged metadata/header denial, membership downgrade, self-enrolment rejection,
TRUNCATE rejection, public-route behavior and publication removal.

Run with Node 24:

```sh
npm ci --prefix supabase/baseline
node supabase/baseline/verify-ting2.mjs
node supabase/tests/ting2/frontend.mjs
npm ci --prefix supabase/baseline/native
TING_TEST_ISSUE=ting2 node supabase/baseline/native/run.mjs
```

The native test needs local Docker and creates an isolated stack. It restores the
exact baseline, runs existing Auth/API/ticket/Realtime/Storage smoke tests, then
runs the new assertions against PostgreSQL 17 and the actual release migration
through CLI dry-run/apply-once/repeat push, preserving original history. Real
Auth/REST checks verify the routing RPC, public settings, private table links,
composite-key upserts, forged-header denial and immediate membership revocation.
No cloud credentials, production connection, deployment or production data is
used. Consult the actual PR workflow result; committed tests are not a pass.
Frontend tests execute the shipped JavaScript with controlled DOM/network
substitutes. They are not a visual browser/mobile or live-CDN test.

## Production review gate and rollout

No merge, deployment, membership assignment or production SQL is authorized by
this draft. Before a separate approved rollout:

1. Recapture live catalogue and exact migration fingerprints. Compare with the
   baseline and nine immutable files. Stop for any unexplained drift.
2. Explicitly review actual user UUID → tenant UUID → owner/admin assignments.
   Zero memberships currently exist. Never infer membership from admin_users,
   email, the single existing tenant, or a client-supplied header.
3. Inspect target settings/table-link rows again. Null ownership aborts the
   migration without guessing a tenant. Multiple settings rows for one tenant
   abort the transaction. Map/correct any rows in a separately reviewed plan.
4. Review an authenticated target dry-run: only 20260918144301 must be pending.
   Do not use include-all, baseline replay, or history repair on production.
5. Schedule a brief maintenance window. Pause admin writes; arrange the reviewed
   memberships; apply the SQL before deploying these frontend changes. Old tabs
   may see no branding or fail table-link writes during this window. Do not
   merge the PR early: merging main triggers automatic Vercel production deploy.
6. Deploy the reviewed frontend, reload admin sessions, and verify missing-client
   behavior, branding, own links/upsert/poll/logout and denied foreign operations
   using authorized test identities. Record deployment SHA, SQL ledger and gates.

The SQL takes brief exclusive locks (five-second lock timeout). Timeout or any
migration error rolls the transaction back; inspect the cause before retrying.
Existing historical SQL is unchanged.

## Recovery

Prefer a forward correction while preserving membership checks and tenant keys.
A frontend-only rollback is insufficient once the new table-link key is active:
old clients omit tenant_id and will be denied. Keep writes paused if necessary.
Do not restore the old global-admin policies or broad public links to recover UI.
Do not drop the tenant key: multiple tenants may now share table numbers, so
reverting the key could fail or require destructive data merging. Preserve data
and prepare a separately reviewed recovery migration after examining the actual
state. Transactional precondition failure/retry is tested; production backup/data
recovery and arbitrary post-release reverse migrations are not established here.
