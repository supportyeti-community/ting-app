# TING-9 deployment, verification, and rollback record

## Final production state — 5 August 2026

- TING-9 ownership enforcement is active in production.
- `public.service_tickets.tenant_id` is `NOT NULL`.
- The strengthened `Public can create pending service tickets` INSERT policy requires a pending ticket, valid request content, a non-null `client_slug`, and resolved non-null `tenant_id` ownership.
- The dedicated `a_assign_service_ticket_tenant` trigger and `ting_private.assign_service_ticket_tenant()` function remain active. They resolve canonical ownership from `client_slug`, reject unknown or conflicting ownership, and prevent ownership changes after creation.
- Seven pre-existing tickets were preserved, with zero null-owned rows after enforcement.
- Admin policies and the Realtime publication membership were not changed by TING-9.
- The deployed customer writer is `index.html` from GitHub commit `41d6c16`.
- Rollback-only enforcement assertions passed, no verification tickets persisted, and no new Supabase advisor finding appeared.

## Recorded deployment history

1. **Checkpoint and preflight.** The live catalog, `service_tickets_pkey`, public INSERT policy, sanitization trigger, tenant-slug uniqueness, Realtime membership, ownership counts, and rollback checkpoint were checked before mutation.
2. **Expansion.** `20260803120000_ting9_service_ticket_ownership_expansion.sql` added `client_slug` and the dedicated canonical-ownership trigger/function without changing existing admin policies or Realtime membership.
3. **Customer writer.** The reviewed `index.html` was deployed and its browser flow, admin queue visibility, Realtime delivery, and retry idempotency were verified, including mobile layout checks performed during Stage 2.
4. **Initial enforcement.** `20260803120001_ting9_service_ticket_ownership_enforcement.sql` made `tenant_id` non-null and strengthened the public INSERT policy.
5. **Conservative rollback.** When the verification package was found to model the retry path incorrectly, enforcement was conservatively relaxed for diagnosis. Ticket IDs, `client_slug`, `tenant_id`, ownership data, and the assignment trigger/function were preserved.
6. **Corrected verification and re-application.** Rollback-only assertions were corrected to model the deployed plain-`INSERT` behavior, enforcement was re-applied, and the final enforced state was verified with all seven existing tickets retained.
7. **Documentation correction.** This file and the rollback-only SQL package were aligned with the production writer. This correction performs no deployment, schema, policy, RLS, Realtime, or application change.

## Deployed retry and idempotency contract

The client generates one UUID before entering the retry loop and reuses that UUID for every attempt. Each attempt issues a plain `INSERT`; the deployed client does **not** use `ON CONFLICT`.

- The first successful insert creates the service ticket.
- If the response is lost and a later attempt repeats the same UUID, PostgreSQL returns SQLSTATE `23505` for `service_tickets_pkey` and identifies that same request UUID in the duplicate-key detail.
- The client treats only that exact duplicate-primary-key response for the same request UUID as idempotent success.
- A `23505` from another constraint, a duplicate referring to another UUID, an ownership/content rejection, an RLS failure, or any other database error remains a failure and must not be swallowed.
- Slow-network retries therefore create at most one ticket for a single assistance action while preserving fail-closed behavior for unrelated errors.

## Verification contract

Use `TING-9-service-ticket-ownership-verification.sql` only with separate execution approval. Its behavioral section runs in one transaction and ends in `ROLLBACK`. It covers:

- canonical tenant assignment for a valid `client_slug`;
- plain-`INSERT` duplicate behavior limited to SQLSTATE `23505`, `service_tickets_pkey`, and the same stable UUID;
- rejection of missing, unknown, and conflicting ownership;
- rejection of invalid request content;
- immutable ticket ownership;
- a normal status update after restoring the privileged verification role;
- structural inspection of RLS policies and Realtime publication membership; and
- restoration of the original row count before the final transaction rollback.

The SQL package validates database behavior. Browser-level duplicate recognition remains evidenced by the reviewed `isExpectedServiceTicketDuplicate(error, requestId)` implementation in deployed commit `41d6c16`; SQL cannot reproduce the Supabase JavaScript error object itself.

## Rollback boundary

TING-9 is already enforced. Do not drop `client_slug`, `tenant_id`, ticket IDs, canonical ownership data, `a_assign_service_ticket_tenant`, or `ting_private.assign_service_ticket_tenant()` as an incident response shortcut.

If a production incident requires rollback:

1. Stop and record the current catalog, policies, row counts, null-ownership count, logs, and a backup/PITR checkpoint.
2. Use a separately reviewed reverse migration—never ad-hoc DDL.
3. The narrow rollback may relax `tenant_id NOT NULL` and restore the immediately preceding public INSERT policy only after impact and writer compatibility are reviewed.
4. Preserve ticket IDs, `client_slug`, `tenant_id`, all existing ownership values, and the assignment trigger/function for investigation and safe re-enforcement.
5. Do not change admin policies or Realtime publication membership.
6. Re-run the approved rollback-only verification and require unchanged persistent row counts before deciding whether to re-apply enforcement.

## Immediate-stop conditions

- Any schema, policy, trigger, grant, function owner/search-path, Realtime membership, or primary-key-name drift.
- Any null `tenant_id` row while enforcement is expected to be active.
- A valid slug cannot resolve, an unknown slug is accepted, supplied ownership can conflict with canonical ownership, or ownership can be mutated after creation.
- A retry path accepts anything other than the same request UUID colliding on `service_tickets_pkey` with SQLSTATE `23505`.
- Existing queue, status-update, RLS, or Realtime behavior regresses.
- Verification changes the persistent service-ticket row count.
