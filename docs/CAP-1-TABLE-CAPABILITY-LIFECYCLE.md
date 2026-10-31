# CAP-1 — Table Capability Lifecycle

## Outcome

Add explicit, tenant-authorized lifecycle controls for existing table bearer capabilities without redesigning guest ordering, guest assistance, tenant routing, or payments.

## Security invariant

A table bearer capability is valid only while its `table_access_contexts.revoked_at` value is null.

CAP-1 adds two staff-only operations:

1. revoke one known capability by context id;
2. atomically revoke all active capabilities for one routed tenant/table and issue one replacement token.

Both operations require:

- a valid routed tenant from `request_tenant_id()`;
- an authenticated actor;
- `can_manage_tenant(routed_tenant_id)` authorization.

Anonymous callers receive no lifecycle RPC grants.

## Rotation semantics

`rotate_table_access_context(table_number)` obtains a transaction-scoped advisory lock keyed to the routed tenant and normalized table number. It then:

1. revokes every currently active capability for that tenant/table;
2. creates a fresh 256-bit random token;
3. stores only its SHA-256 hash;
4. returns the plaintext replacement token once.

The lock prevents concurrent staff rotations from leaving multiple newly-issued credentials active.

## Scope boundaries

CAP-1 does not modify:

- `submit_order`;
- `submit_service_ticket`;
- PAY-2 or payment processor code;
- tenant routing;
- order status transitions;
- Realtime behavior;
- production Supabase state or Vercel configuration.

The existing validation helper already requires `revoked_at IS NULL`, so revoked credentials automatically fail existing ordering and assistance gates.

## Current acceptance gap

The backend lifecycle RPCs do not, by themselves, provide a finished staff-facing revoke/replace control in the admin UI. The current secure QR generator still uses `issue_table_access_context`.

Do not call CAP-1 product-complete until the admin workflow deliberately exposes replacement semantics, validates the returned token, and regression coverage proves the old credential stops working while the replacement works.

## Required verification before merge recommendation

- TING-11 static contracts pass.
- TING-11 disposable native rehearsal is updated to apply this migration and behaviorally prove revoke/replace semantics.
- Cross-tenant revoke and rotate attempts fail closed.
- Membership revocation removes lifecycle authority.
- Revoked credentials fail both ordering and assistance.
- Replacement credential works only for the same canonical tenant/table.
- No PAY-2 files are modified.

Until those behavioral checks and the staff-facing workflow are present, merge recommendation is **HOLD**.
