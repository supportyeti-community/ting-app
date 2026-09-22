# TING-2: menu-item isolation — review draft

## Live evidence and scope

This is the second bounded TING-2 release. It does not close TING-2 or authorize
a production rollout. On 22 September 2026, read-only checks against production
showed that `menu_items` returned the same tenant row when `x-client-slug` was
missing, unknown, or correct. The baseline also permits any legacy
`admin_users` account to mutate every tenant's menu. Main was refreshed at
`b232031173c4198a8b87213c4642b2bdaba28008` before this work began. No production
data or schema was changed.

The Notion, GitHub, and Supabase connectors returned invalid request-metadata
errors during the refresh. The selection is therefore based on the previously
read canonical TING-2 issue and handbook, the current merged repository, its
review notes, and direct read-only production Data API evidence. The issue
remains a P0 release blocker.

## Access contract

- Every menu item must have a tenant UUID whose tenant slug matches the item's
  `client_slug`. Existing inconsistent or unowned rows abort the migration.
- Anonymous menu reads require a known `x-client-slug` and return only that
  tenant's rows. Missing, malformed, and unknown routing fails closed.
- Authenticated owners and admins manage menu rows only through database-backed
  `tenant_memberships`. The legacy global allowlist, JWT metadata, and a forged
  routing header grant no write access.
- Tenant UUID and client slug cannot be reassigned after insert. Prices and
  promotional prices retain their non-negative checks.
- `anon` has SELECT only. `authenticated` has row-policy constrained CRUD. No
  client role receives TRUNCATE or DDL access.
- `menu_items` leaves the Realtime publication because deleted-row events cannot
  be safely tenant filtered by RLS. Customer and staff pages use tenant-scoped
  REST reads every ten seconds; all staff writes also include the tenant filter.

This slice does not change menu analytics, service tickets, storage objects,
routing administration, membership provisioning, or other remaining TING-2 and
TING-4 boundaries.

## Verification

The PostgreSQL-engine suite first reproduces the broad public read and global
admin write. It then covers migration rollback/retry, missing and unknown routes,
both tenant directions, anonymous write denial, own and foreign CRUD, mismatched
slugs, negative prices, immutable ownership, legacy global-admin denial,
TRUNCATE denial, membership revocation, and publication removal.

The frontend suite executes the shipped inline JavaScript and checks every menu
read and mutation for an explicit tenant boundary, required ownership on insert,
ten-second polling, and absence of an unsafe menu Realtime subscription. The
native Supabase rehearsal restores the immutable nine-migration baseline, runs
the first TING-2 release, applies this migration through CLI dry-run/apply/repeat,
checks the migration ledger, and exercises real Auth and Data API requests.

Local checks:

```sh
node supabase/tests/ting2/frontend.mjs
node supabase/tests/ting2/menu-frontend.mjs
node supabase/baseline/verify-ting2.mjs
```

The full native test requires Docker and runs in the pull-request workflow. The
current workspace has no Docker executable, so the workflow result is the native
test authority. No cloud credentials are used by the tests.

## Review and rollout gate

Merging main triggers the production frontend deployment, so this work must stay
in draft until review. Before a separately approved rollout:

1. Refresh production rows, policies, publication membership, migration ledger,
   and immutable migration fingerprints. Stop on unexplained drift.
2. Confirm every existing menu row has the intended tenant UUID and matching
   slug. The migration deliberately refuses to infer or repair ownership.
3. Confirm the staff account has an owner/admin membership for that tenant.
4. Run an authenticated production dry-run and confirm only this reviewed
   migration is pending. Do not repair or replay migration history.
5. Apply the database migration before deploying the frontend during a short
   write pause. Then deploy the reviewed commit and reload open customer/admin
   sessions.
6. Verify missing and unknown routes, the real customer menu, menu CRUD and
   ordering, stock/price/promotion changes, a second-session polling refresh,
   and denied foreign writes. Record the SQL ledger and deployment commit.

The migration uses a five-second exclusive-lock timeout and is transactional.
Any ownership inconsistency, lock timeout, or SQL error rolls it back. Recovery
should preserve tenant ownership and use a separately reviewed forward
correction; restoring broad public or global-admin policies would reopen the
confirmed isolation gap.
