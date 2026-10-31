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

`rotate_table_access_context(table_number)` obtains a transaction-scoped advisory lock keyed to the routed tenant and normalized table number. Ordinary `issue_table_access_context(table_number)` issuance obtains the same lock. Rotation then:

1. revokes every currently active capability for that tenant/table;
2. creates a fresh 256-bit random token;
3. stores only its SHA-256 hash;
4. returns the plaintext replacement token once.

The shared lock prevents concurrent staff rotations from leaving multiple newly-issued credentials active and prevents ordinary issuance from crossing the revoke-and-replace boundary.

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

## Staff workflow

The admin order-board module installs a separate table-credential replacement control through `installTableCredentialRotationControl`. It requires explicit confirmation before calling `rotate_table_access_context`, warns staff that previous QR/NFC links for that table will stop working, validates the returned replacement token, and renders the replacement QR.

Ordinary **Generate QR** remains intentionally non-destructive and continues to use `issue_table_access_context`.

## Verification evidence

The disposable TING-11 native rehearsal applies the CAP-1 lifecycle migration and behaviorally covers:

- anonymous revoke and rotate denial;
- cross-tenant routed revoke denial;
- retry-safe specific revocation;
- revoked credential rejection for both ordering and assistance;
- intentional multiple active credentials from ordinary issuance;
- rotation revoking all prior active credentials for one routed tenant/table;
- exactly one replacement remaining active immediately after rotation;
- replacement success for the same table and failure for another table;
- membership revocation removing issue, revoke, and rotate authority.

Focused TING-11C contract coverage also verifies that ordinary QR generation remains non-destructive while the separate confirmed replacement path uses `rotate_table_access_context`.

## Merge recommendation gate

Merge recommendation remains **HOLD** until the current PR head has completed the required CI/rehearsal checks and CodeRabbit has no unresolved material findings. No PAY-2 files may be modified, and any shared-risk `main` drift must be revalidated before merge.
