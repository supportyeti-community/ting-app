# TING-2: menu-event isolation — review draft

## Live evidence and scope

This is the third bounded TING-2 release. It does not close TING-2 or authorize
a production rollout. Read-only production checks on 22 September 2026 found
123 `menu_events` rows, all owned by the expected tenant with matching client
slugs, and no event referring to a menu item from another tenant. The current
policy nevertheless accepts a public analytics insert based on its submitted
slug without binding it to the resolved request route, while the legacy global
admin allowlist can read and delete every tenant's analytics. Main was refreshed
at `e602a4d8eb48bd529427c2d691972fd098c8f0a4` before this work began. No
production data or schema was changed.

The canonical Notion issue remains in progress and a P0 release blocker. This
slice changes only `menu_events`, its two frontend call sites, and the related
verification. Restaurant routing, tickets, storage objects, membership
provisioning, and other remaining TING-2/TING-4 boundaries stay out of scope.

## Access contract

- Every event must have a tenant UUID whose tenant slug matches the event's
  `client_slug`. Existing unowned or mismatched rows abort the migration.
- Public telemetry inserts require a known `x-client-slug` whose resolved tenant
  matches the event. Missing, malformed, unknown, or conflicting routes fail
  closed.
- An optional `item_id` must identify a menu item owned by the same tenant.
  Existing cross-tenant references abort the migration.
- Analytics are append-only for client roles. Anonymous clients receive INSERT
  only. Authenticated owners/admins receive policy-constrained SELECT, INSERT,
  and DELETE; neither client role receives UPDATE, TRUNCATE, or DDL access.
- Staff reads and deletes derive authorization only from database-backed
  `tenant_memberships`. A forged routing header, JWT metadata, or the legacy
  global allowlist does not grant analytics access.
- The customer page sends both the resolved tenant UUID and canonical slug.
  Staff analytics queries also include the tenant UUID explicitly.
- `menu_events` remains outside the Realtime publication, so deleted rows cannot
  bypass tenant filtering through unfilterable change events.

## Verification

The PostgreSQL-engine suite first reproduces the global-admin read and
route-unbound public insert. It then covers atomic rejection and retry for
unowned rows and cross-tenant item references; missing, malformed, unknown, and
conflicting routes; same-tenant item references; both tenant directions;
anonymous read denial; member read/delete; update and TRUNCATE denial; global
admin denial; membership revocation; and publication state.

The frontend suite checks explicit ownership on customer telemetry and a tenant
UUID filter on all three staff analytics queries. The native Supabase rehearsal
restores the immutable migration baseline, applies all prior TING-2 releases,
runs CLI dry-run/apply/repeat for this migration, verifies the ledger, and
exercises real Auth and Data API requests.

Local checks:

```sh
node supabase/tests/ting2/frontend.mjs
node supabase/tests/ting2/menu-frontend.mjs
node supabase/tests/ting2/menu-events-frontend.mjs
node supabase/baseline/verify-ting2.mjs
```

The full native test requires Docker and runs in the pull-request workflow. No
cloud credentials are used by the tests.

## Review and rollout gate

Merging main triggers the production frontend deployment, so this work must stay
in draft until review. Before a separately approved rollout:

1. Refresh production event ownership, item references, policies, grants,
   publication membership, migration ledger, and immutable migration hashes.
   Stop on unexplained drift.
2. Confirm every existing event has the intended tenant UUID and matching slug,
   and every non-null item reference belongs to that tenant. The migration does
   not infer or repair ownership.
3. Confirm the staff account has an owner/admin membership for the tenant.
4. Run an authenticated production dry-run and confirm only this reviewed
   migration is pending. Do not repair or replay migration history.
5. Apply the database migration before deploying the reviewed frontend during a
   short analytics-write pause. Then deploy the reviewed commit and reload open
   customer/admin sessions.
6. Verify a real customer telemetry insert, missing/unknown/foreign-route denial,
   staff analytics totals and top item, member deletion, foreign/global-admin
   denial, and membership revocation. Record the SQL ledger and deployment
   commit.

The migration uses a five-second lock timeout and is transactional. Any
ownership inconsistency, lock timeout, or SQL error rolls it back. Recovery
should preserve tenant ownership and use a separately reviewed forward fix;
restoring broad client grants or global-admin policies would reopen the confirmed
isolation gap.
