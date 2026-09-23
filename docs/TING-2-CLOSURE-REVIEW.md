# TING-2 closure review — 23 September 2026

This record assesses the canonical TING-2 acceptance criterion: classify every
public table and enforce/test tenant ownership and row policies on tenant-owned
tables. It does **not** authorize a second production tenant or close TING-4/8.

## Live catalogue and classification

Read-only production inspection after PR #9 found nine public tables, all with
RLS enabled. The Bistro is still the only tenant and route; one membership
exists. Two-tenant isolation is verified in disposable native CI, not inferred
from the single-tenant production data.

| Table | Classification and effective client boundary |
| --- | --- |
| `restaurant_settings` | Tenant-owned branding. `tenant_id` required; public exact-route read; membership-scoped staff CRUD. |
| `table_configurations` | Tenant-owned table links. `tenant_id` required and in the composite key; no public access; membership-scoped CRUD. |
| `menu_items` | Tenant-owned menu. `tenant_id` and slug required; public exact-route read; membership-scoped CRUD. |
| `menu_events` | Tenant-owned analytics. `tenant_id` and slug required; public route-bound INSERT only; membership read and DELETE. UPDATE is intentionally denied. |
| `service_tickets` | Tenant-owned assistance. `tenant_id` and slug required; public route-bound INSERT; membership read and status UPDATE. Client DELETE is intentionally denied; tenant-filtered INSERT/UPDATE Realtime retained. |
| `tenants` | Private operator-managed tenant registry. No direct anon/authenticated grants or policies; narrow UUID route helper. |
| `tenant_memberships` | Private operator-managed authorization registry. No direct anon/authenticated grants or policies; membership helper checks owner/admin. |
| `restaurant_clients` | Public platform routing registry. SELECT is exact `x-client-slug` scope, with a **single headerless Bistro compatibility exception** for cached pages. No client writes. Slug is public context, not authorization. |
| `admin_users` | Legacy platform allowlist. Authenticated own-row SELECT only; no client writes. `is_admin()` still supports legacy `menu-pictures` Storage policies. |

All five tenant-owned tables require non-null tenant UUIDs. SQL and native
Auth/REST tests cover cross-tenant reads/writes, forged headers/metadata,
missing routes, membership revocation and deliberately denied verbs. The
native [TING-2 isolation run 35867016190](https://github.com/supportyeti-community/ting-app/actions/runs/35867016190)
and [baseline restore run 35867015878](https://github.com/supportyeti-community/ting-app/actions/runs/35867015878)
passed at reviewed PR #9 head `9594bf5ce5d090e55ab15b954b7e75bc8a4fd6d6`.
Production has 15 migration records; the last is
`20260923132307_ting2_route_scope_registry`, fingerprint
`e907dffb7ff86ad6b84322a608a2435e`. PR #9 merged at
`6b0f9de7c09662e6b69174c88c84647531ec9ec5`, and Vercel production
`dpl_ALz8XYtqzxNB1gd1wFEh8UvKCjyu` is READY at that commit. Live Bistro
menu and staff login smoke passed without submitting an assistance ticket.

## Boundaries retained for other tickets

- TING-4 (Not started, P1) governs `menu-pictures` object listing and tenant
  paths. The live bucket has five objects with no Bistro path prefix. Its
  public SELECT and global `is_admin()` write policies are **not** tenant
  isolated. Do not reuse that legacy allowlist as tenant authorization.
- TING-8 (In progress, P0) governs broader tenant provisioning, Storage and
  Realtime work. Provisioning a second production tenant is not established.
- The headerless Bistro route can remain visible indefinitely to old cached
  pages. Its retirement requires a separate compatibility decision; no runtime
  evidence here proves that all old tabs have disappeared.

**Closure recommendation:** the table-classification and tenant-owned table
acceptance target for TING-2 is met. Mark TING-2 Done only as that bounded
table-scope item; keep TING-4/8 open and the second-tenant release gate active.
