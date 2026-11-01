# TinG Production Release Policy

## Purpose

TinG treats production release as a controlled engineering decision, not the end of coding. A change is **Prod Green** only when the required **pre-merge / pre-release** evidence for its risk level is complete and there are no unresolved blocking findings. Post-release production verification is a separate obligation used to determine whether a deployed change is **Released** and then **Stable**.

## Core release path

1. Define the intended outcome and explicit non-goals.
2. Build on a branch; do not treat `main` as a working branch.
3. Open a pull request.
4. Run automated verification.
5. Perform an internal code review.
6. Perform a security review.
7. Obtain an independent CodeRabbit review when required.
8. Verify the deployed preview/staging path.
9. Merge only when the required pre-merge gates are green and the PR is Prod Green.
10. Deploy to production.
11. Verify the affected production path after deployment.
12. If production behavior is abnormal, contain or roll back before attempting broad live repair.

## Risk classes

### Low

Typical examples: copy, icons, spacing, non-functional presentation changes.

Required pre-merge evidence:
- internal code review;
- automated checks relevant to the changed files;
- preview verification;
- a security-impact assessment confirming whether dedicated security review is required.

Low risk does **not** mean security review is categorically exempt. If the security-impact assessment identifies any effect on trust boundaries, data authority, tenant resolution, authentication, authorization, persistence, ordering, payments, migrations, secrets, or exposed configuration, the change must be reclassified and the appropriate security review performed.

Required post-release evidence:
- verify the affected production path or rendered surface after deployment when the change reaches production;
- if verification fails, contain, roll back, or apply a reviewed forward-fix appropriate to the blast radius.

A low-risk change must be reclassified if it touches data authority, tenant resolution, authentication, authorization, persistence, ordering, payments, or migrations.

### Medium

Typical examples: component behavior, dashboard logic, guest-flow logic, API consumption, order-state UI behavior.

Required pre-merge evidence:
- internal code review;
- security-impact review;
- automated checks;
- CodeRabbit review;
- preview smoke test;
- rollback path understood.

Required post-release evidence:
- production smoke test of the affected path;
- if verification fails, contain, roll back, or apply a reviewed forward-fix according to the documented recovery path.

### High

Typical examples: tenant isolation, RLS/policies, authentication, authorization, privileged actions, database migrations, ordering write paths, payments, vouchers/entitlements, service-role boundaries, production configuration with security impact.

Required pre-merge evidence:
- internal code review;
- dedicated security review;
- automated checks and relevant regression tests;
- CodeRabbit review;
- preview/staging smoke test;
- adversarial negative-path test;
- explicit blast-radius assessment;
- explicit rollback or forward-fix plan.

Required post-release evidence:
- production smoke test of the affected path;
- immediate containment or rollback if the production verification fails.

A High-risk PR may become **Prod Green** before production deployment when all required pre-merge evidence is complete. It becomes **Released** only after the required production smoke test passes.

## Blast radius

Every medium/high-risk PR must classify maximum plausible blast radius:

- **Local** — one component or page.
- **Flow** — one guest/admin journey.
- **Tenant** — one venue's data or operations.
- **Platform** — multiple/all tenants, shared infrastructure, auth, global data boundaries, or payment authority.

Platform blast radius defaults to High risk.

## Review gates

### 1. Internal code review

Answer: **Does the implementation correctly deliver the intended outcome without introducing avoidable regressions or unsafe complexity?**

Review correctness, edge cases, failure handling, maintainability, duplication, compatibility, tests, and affected guest/venue flows.

### 2. Security review

Answer: **Does the change preserve TinG's security invariants and fail closed?**

Every PR records a security-impact assessment. Low-risk PRs may mark dedicated security review **N/A** only when the assessment concludes that no relevant security boundary is touched and the rationale is recorded in the PR. Medium- and High-risk PRs require the security review defined by their risk class.

At minimum review, when relevant:
- canonical `tenant_id` ownership and cross-tenant isolation;
- RLS/policies and database grants;
- authentication versus authorization;
- privileged operations and role checks;
- client-supplied IDs/slugs and browser authority;
- secret exposure and environment separation;
- input validation/injection/XSS risk;
- replay, duplicate submission, enumeration and abuse paths;
- migration/data-integrity risk.

### 3. Automated verification

Automation is evidence, not a substitute for review. Relevant syntax, contract, regression and feature-specific workflows must be green at the PR head being considered for merge.

### 4. CodeRabbit

CodeRabbit is an independent reviewer, not the system architect or final authority. Findings are classified as:
- **Blocker** — must be resolved before merge.
- **Important** — resolve unless a documented technical reason justifies acceptance.
- **Minor** — fix when worthwhile.
- **Noise/style** — may be declined with rationale.

A material code change after review invalidates any affected approval and requires re-review of the touched area.

### 5. Preview/staging verification

Test the actual affected journey, not only isolated functions. For ordering-related changes this normally includes the guest path and venue/admin path. High-risk tenant work must include a negative cross-tenant assertion.

### 6. Production verification

Production verification happens **after deployment** and is not a pre-merge Prod Green gate. It confirms that the deployed change behaves correctly in the live environment and determines whether the deployment can be called **Released**. Failure triggers containment, rollback, or a reviewed forward-fix according to the documented recovery plan.

## TinG security invariants

These must remain true unless an explicitly approved architecture decision changes them:

1. One tenant cannot read or write another tenant's protected data.
2. Authentication alone does not grant authorization.
3. Guests cannot obtain venue/admin authority.
4. The browser may request; server/database authority decides protected state.
5. Client-supplied tenant, price, ownership, role and entitlement values are not trusted as final authority.
6. Service-role or equivalent privileged secrets must never be exposed to browser code.
7. Production secrets must not be casually exposed to preview environments.
8. Security boundaries are tested negatively as well as positively.
9. Destructive or ownership-changing data operations require explicit safeguards and recovery thinking.

## Database and migration rules

Database changes receive elevated scrutiny because application code is easier to revert than production data.

Before production, determine:
- whether existing rows can be damaged or made unreadable;
- whether deployment is backward-compatible with the currently deployed app;
- whether the operation is retry-safe/idempotent where relevant;
- whether a checkpoint/backup/PITR boundary is required;
- whether rollback is safe or a forward-fix is required;
- which verification proves persistent row counts/ownership remain valid.

Never use ad-hoc destructive DDL as an incident-response shortcut when a reviewed recovery path is required.

## Merge blockers

A PR is not Prod Green with any unresolved item involving:
- cross-tenant exposure or ownership ambiguity;
- authentication/authorization bypass;
- exposed privileged secret;
- uncontrolled destructive migration/data-loss risk;
- incorrect payment authority, amount, idempotency or reconciliation boundary;
- failing required CI/regression check;
- unresolved CodeRabbit Blocker;
- failed required preview/adversarial test;
- unknown recovery path for a High-risk change.

## Exceptions

A non-blocking finding may be accepted only with a short rationale recorded in the PR. Security-boundary, data-loss, payment-integrity and tenant-isolation blockers are not casually waivable.

## Release status language

- **Built** — implementation complete.
- **Reviewed** — internal code review passed.
- **Secured** — required security review passed, or a Low-risk security-impact assessment recorded why dedicated review is N/A.
- **Verified** — required automation and independent review passed.
- **Staged** — required preview/staging verification passed.
- **Prod Green** — all required pre-merge gates for the current risk class have passed; no blocking finding remains; recovery is understood; safe to merge/deploy within the stated blast radius.
- **Released** — production deployment and required production verification passed.
- **Contained** — post-release verification found an issue and the affected behavior was safely disabled, isolated, or otherwise limited.
- **Rolled Back** — the deployment was reverted to the last known-good state.
- **Forward Fixed** — a reviewed corrective change restored the affected production path without rollback.
- **Stable** — no material release-related issue observed after verification.

## Prod Green

**Prod Green** means the change has satisfied every **pre-merge** gate required by its risk class at the current PR head, there is no unresolved blocking finding, the recovery path is understood, and the change is safe to release within the stated blast radius.

Post-release production smoke testing is deliberately excluded from the Prod Green pre-merge definition. It is required to move a deployment from **Prod Green** to **Released** when the change's risk class requires it.

"Code complete", "CI green", or "CodeRabbit approved" alone never means Prod Green.
