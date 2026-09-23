# TING-2 routing registry: compatibility preparation

## Boundary

This is a preparation release, not the final platform-routing cutover or TING-2 closure.
The live `restaurant_clients` public SELECT policy remains global for old customer
and staff pages. Both new bootloaders send `x-client-slug` on the master routing
client, as they already do on the tenant client. A subsequent reviewed migration
must make the registry SELECT policy route-bound after the new frontend is live.

The two registry tables keep RLS enabled. This migration removes all direct
browser-side mutations and `TRUNCATE`, `REFERENCES`, and `TRIGGER` privileges on
`restaurant_clients` and `admin_users`. The registry retains `SELECT` for anon
and authenticated clients during the compatibility window. The legacy allowlist
retains authenticated own-row `SELECT`, because `is_admin()` is still used by
menu-pictures storage policies. Trusted service/operator roles retain their
existing privileges; no platform provisioning or account identities change.

## Rollout order and verification

1. Review the exact migration file and CI head. Confirm live policy names, RLS,
   current grants, and a matching tenant for each routing row. Stop on drift.
2. Apply the database migration first. Verify client roles have only the listed
   `SELECT` grants and the old route lookup still works without a header.
   Confirm `is_admin()` still works for the existing admin and storage uploads.
3. Merge only the tested head. Confirm the production deployment's commit, then
   load the customer menu and staff login with a valid route and check a missing
   route. Inspect request headers in browser/devtools as needed without logging
   authorization values. Confirm the customer-to-staff assistance path remains
   functional with an authorized manual check.
4. Record the result in the canonical TING-2 item. Keep TING-2 in progress.

The native CI rehearses CLI dry-run, apply and repeated no-op on a disposable
stack, and checks policy/grant behavior. The frontend test checks both master
and tenant client headers. CI is required before production approval; a local
JavaScript pass alone is insufficient.

## Recovery and next slice

If a precondition or migration statement fails, its transaction rolls back.
If the frontend deployment fails, the database state remains compatible with
the old frontend. Restore the last working frontend commit if required; keep
the narrowed database privileges. Do not restore global client write grants.

Next: verify that both deployed bootloaders send the header, then replace the
global registry `SELECT` policy with an exact route-bound read and test missing,
unknown and forged routes. Classify the routing registry explicitly; address
the remaining `admin_users` dependency and storage boundary separately.
