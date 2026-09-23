# TING-2 routing registry read scope — draft release review

## Boundary

`restaurant_clients` is a public platform routing registry. Its browser-visible Supabase URL and anonymous key are public connection details; a route slug is not tenant authorization. The existing customer and staff bootloaders send `x-client-slug` and filter the registry query by the same slug. RLS now also limits the result to the exact header slug, including requests that omit the frontend filter. This does not change grants, tenant-owned policies, provisioning, Storage, or the `admin_users` own-row read used by `is_admin()`.

The sole compatibility exception is an absent header: it returns **only `the-bistro`**, the existing internal-demo route. Cached pages from before PR #8 can keep bootstrapping. Future routes are hidden from those pages. An unknown slug, explicit empty header, malformed header, and a mismatched header/filter return zero rows. A caller may set any valid known slug and read that *public* route; it cannot acquire tenant membership from this header. Do not onboard a second tenant while older client behavior and broader routing/provisioning work remain unreviewed.

The headerless Bistro route remains publicly discoverable. Retiring that fallback requires a separate compatibility decision; there is no reliable server-side way to infer an old page's slug from a missing header. The current HTML is served with `Cache-Control: public, max-age=0, must-revalidate`, but already-held tabs and older cached copies are still possible.

## Table classification

| Public table | Ownership/read boundary |
| --- | --- |
| `restaurant_settings`, `table_configurations`, `menu_items`, `menu_events`, `service_tickets` | Tenant-owned; earlier TING-2 migrations enforce ownership and RLS. Events are intentionally append-only for anonymous clients; ticket deletes remain disabled. |
| `tenants`, `tenant_memberships` | Private operator-managed registries; RLS enabled, no direct client grants or policies. A narrowly granted helper resolves the public route UUID. |
| `restaurant_clients` | Public platform routing registry; exact slug read with a single legacy Bistro fallback; service/operator writes only. |
| `admin_users` | Legacy platform allowlist; authenticated own-row read retained for `menu-pictures` Storage authorization, service/operator writes only. |

## Verification and release

- Local PGlite baseline replay covers both roles, valid A/B routes, old headerless Bistro, missing/unknown/malformed/forged headers, wrong query filter and unchanged registry grants. Native CI exercises migration ledger preservation, dry-run/apply/no-op and real anonymous/authenticated REST reads.
- Apply the migration **only after approval**. The deployed customer and staff pages already send the header. Confirm live preflight: PR #8 head still deployed, sole Bistro route present, original global policy intact, migration ledger unchanged, no second tenant.
- After database rollout verify two roles, valid Bistro, unknown/wrong header and headerless compatibility via independent REST/SQL probes; ensure the migration ledger and `is_admin()` remain correct. Merge the exact green reviewed head, then confirm Vercel production alias and customer menu/staff login.
- No live assistance request is part of this smoke. TING-2 stays **In progress / P0** after this release until compatibility retirement and broader routing/provisioning boundaries are reviewed.
