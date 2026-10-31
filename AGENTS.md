# TinG Engineering Agent Constitution

This file defines repository-level operating rules for AI coding agents and automated reviewers working on TinG. It supplements, and does not replace, the TinG Product OS, TinG Engineering Handbook, `README.md`, repository governance, reviewed design documents, migrations, CI, and runtime evidence.

## 1. Authority and decision order

Use the source closest to the decision being made:

1. TinG Product OS — product direction, sequencing and durable product decisions.
2. TinG Engineering Handbook — architecture, engineering workflow, QA, verification and implementation evidence.
3. This repository — executable truth for code, migrations, branches, PRs, tests and releases.
4. Supabase, Vercel and provider configuration — runtime truth that must be reconciled into engineering records when materially different from Git.

Do not infer product intent from code alone. If sources disagree, verify execution/runtime truth first, then reconcile higher-level documentation before proceeding.

## 2. Core engineering priorities

In order of precedence:

1. Tenant isolation and authorization.
2. Correctness of order, payment and financial state.
3. Reliability and recoverability.
4. Explicit failure handling and observability.
5. Product behavior and usability.
6. Novelty or convenience.

Do not weaken a higher-priority boundary to simplify a lower-priority concern.

## 3. Tenant and routing boundaries

- Treat tenant context as mandatory for tenant-owned data and operations.
- Fail closed when required client, tenant or table context is missing, malformed, unknown or inconsistent.
- Do not introduce a default venue, silent tenant fallback or cross-tenant query path.
- `x-client-slug` is routing context where used; it is not tenant authorization by itself.
- Keep tenant-owned reads and writes explicitly tenant-scoped even when RLS also protects them.
- Staff authority must come from reviewed authentication/authorization logic and tenant membership, not from browser-supplied tenant identifiers alone.
- Never reuse legacy platform allowlists as tenant authorization unless a reviewed work item explicitly requires it.

Historical compatibility exceptions documented in reviewed release records are not permission to create new fallbacks.

## 4. Browser and database authority

The browser may request actions; it must not become authoritative for protected state.

- Server/database logic remains authoritative for tenant ownership, order state, totals/pricing, stock validation, payment state and other protected business state.
- Preserve the reviewed RPC boundary for guest ordering (`submit_order`) and the secured assistance boundary (`submit_service_ticket`) unless a bounded work item explicitly changes them.
- Do not introduce new direct guest writes to order or service-ticket tables.
- Existing legacy browser-write paths must not be copied, broadened or treated as the preferred architecture.
- Check the returned `error` from every Supabase/database operation that can fail. Do not discard errors on security-, order-, payment-, migration- or state-changing paths.
- Non-critical presentation/branding failures may degrade gracefully only when doing so cannot hide a security, tenancy, ordering or payment failure.

## 5. Orders and payments

- Revalidate orderable items, availability, price and totals at the authoritative boundary when an order is submitted.
- Preserve idempotency for retryable guest and provider operations.
- Keep payment state and fulfilment/order state machines separate.
- Never enable real money movement from a preview, demo or incomplete provider integration.
- Payment changes must document provider mode, idempotency boundary, reconciliation path, webhook/callback authority, secrets/configuration and whether real or test mutations occurred.
- Treat payment-provider responses as external input that requires verification and reconciliation.

## 6. Realtime and reliability

Realtime is an acceleration mechanism, not the sole source of truth.

When changing live operational surfaces, preserve an appropriate recovery path such as polling, refetch on visibility regain, refetch on network recovery, or explicit reconciliation. A dropped Realtime subscription must not permanently strand staff or guest state.

Do not remove an existing fallback/recovery mechanism without equivalent evidence that the replacement is safer.

## 7. Database and migrations

For schema, policy, function, grant or migration changes:

- Review RLS and grants for both intended and unintended roles.
- Keep tenant identifiers non-null and structurally enforced where the domain requires ownership.
- Prefer tenant-safe relational constraints, including composite ownership relationships where applicable.
- Harden security-definer/helper functions appropriately, including controlled `search_path` where relevant.
- Do not rename an applied migration except for explicit ledger reconciliation with verified unchanged semantics.
- Rehearse restore/forward/retry behavior appropriate to the risk.
- Record rollback or forward-recovery behavior; do not assume rollback is always the safest production response.
- Distinguish disposable/local verification from production evidence.

## 8. Security review expectations

For changes that can affect tenant boundaries, authentication, authorization, guest mutation, Storage, Realtime, ordering or payments, reviewers must actively look for:

- missing tenant filters;
- forged or browser-controlled authority;
- permissive RLS/grants;
- cross-tenant foreign-key/reference paths;
- direct guest writes that bypass reviewed RPCs;
- unchecked database errors;
- retry paths that are not idempotent;
- stale-data behavior after Realtime/network interruption;
- secrets or privileged configuration exposed to the browser;
- preview/sandbox evidence being represented as production certification.

Absence of an obvious exploit is not sufficient evidence that a tenancy boundary is correct.

## 9. Scope discipline

- Implement only the bounded requested outcome.
- Do not add unrelated features, refactors, abstractions or cleanup while touching a ticket unless required for correctness or safety.
- Prefer small, reviewable branches and PRs.
- Do not delete or rewrite historical evidence merely for tidiness.
- Do not silently change product terminology. Guest-facing and product documentation should use **guest/guests**, not customer/customers, unless quoting a historical file or external source.
- When completing work, list every modified file and call out any material out-of-Git configuration dependency.

If a safer implementation requires broader scope, stop and identify that scope expansion explicitly rather than smuggling it into the patch.

## 10. Verification and merge gate

Before recommending merge, establish which checks are relevant and report their actual status.

At minimum consider:

- feature/unit/static checks;
- tenant/isolation regression checks;
- migration/baseline restore checks;
- relevant ordering/payment contract checks;
- manual/runtime verification where automation cannot prove the behavior;
- unresolved review threads and known acceptance gaps.

A green feature workflow does not automatically replace baseline, isolation or cross-layer checks.

Never call a change production-certified solely because code review, CI, a preview deployment or a happy-path demo passed.

## 11. Review output

When reviewing a TinG change:

1. Summarize the bounded outcome.
2. Identify modified files and affected trust boundaries.
3. Put tenant/security, order/payment correctness and data-loss risks first.
4. Separate confirmed defects from suggestions.
5. Give a concrete fix for each material issue.
6. State what was verified and what remains unverified.
7. End with an explicit merge recommendation: **GO**, **HOLD**, or **GO WITH FOLLOW-UP**, with reasons.

Do not approve a change merely because it is stylistically clean or passes generic best-practice checks.

## 12. Repository-specific references

Before material work, consult the relevant current sources, especially:

- `README.md`
- `docs/REPOSITORY-GOVERNANCE.md`
- current design/release records in `docs/`
- relevant files under `supabase/migrations/` and `supabase/baseline/`
- relevant workflows under `.github/workflows/`
- `.github/PULL_REQUEST_TEMPLATE.md`

Historical review documents are evidence of what was true at that release point. They must not automatically override newer code, migrations, Product OS decisions, Engineering Handbook decisions or runtime evidence.
