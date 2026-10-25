## Outcome

<!-- What bounded engineering/product outcome does this PR deliver? -->

## Authority / work item

<!-- Link or identify the TinG Product OS decision / Engineering Handbook work item. Use N/A only for pure repository maintenance. -->

## Scope

### Included
-

### Explicitly excluded / deferred
-

## Release classification

- Risk: **Low / Medium / High**
- Maximum plausible blast radius: **Local / Flow / Tenant / Platform**
- Security-sensitive: **No / Yes — explain:**
- Security-impact assessment:
- If dedicated security review is N/A, rationale:
- Prod Green gates required by `RELEASE_POLICY.md`:

## Security and tenant impact

- Tenant ownership/isolation impact:
- Authentication/authorization impact:
- Browser authority changed? **No / Yes — explain:**
- New secrets or sensitive data? **No / Yes — explain:**
- Negative/adversarial assertion required? **No / Yes — describe:**

## Database / migration impact

- Schema or migration change: **No / Yes**
- Production migration already applied: **No / Yes — evidence:**
- Existing-row/data-integrity risk:
- Backward compatibility with currently deployed app:
- Restore / forward / retry rehearsal:
- Rollback / recovery path:

## Production / configuration impact

- Vercel/config change: **No / Yes — explain:**
- Supabase out-of-Git change: **No / Yes — explain:**
- External provider/config change: **No / Yes — explain:**

## Payments boundary (complete when relevant)

- Provider mode: **N/A / sandbox / live**
- Real money movement enabled: **No / Yes**
- Idempotency boundary:
- Reconciliation path:
- Webhook/callback authority:
- Provider secrets/config required:
- Real or test payment/provider mutation performed: **No / Yes — evidence:**

## Verification evidence

### Automated
-

### Internal code review
- Status: **Pending / Pass / Blocked**
- Material findings:

### Security review
- Status: **N/A / Pending / Pass / Blocked**
- Security-impact assessment/rationale:
- Security invariants/negative paths checked:
- Material findings:

### CodeRabbit
- Status: **N/A / Pending / Pass / Blocked**
- Unresolved blocker/important findings:
- Accepted non-blocking findings and rationale:

### Preview / staging smoke test
- Status: **Pending / Pass / Blocked**
- Guest flow tested:
- Venue/admin flow tested:
- Cross-tenant negative test (when required):

### Production smoke test
<!-- Complete after release when required. -->
- Status: **N/A / Pending / Pass / Contained / Rollback triggered / Forward fixed**
- Evidence/notes:

## Acceptance gaps / unresolved risk

-

## Merge gate — Prod Green

- [ ] Scope matches the canonical work item/product decision.
- [ ] Risk and blast radius are classified correctly.
- [ ] Security-impact assessment is recorded; any N/A dedicated security review has rationale.
- [ ] Required automated checks pass at the current PR head.
- [ ] Internal code review passes.
- [ ] Required security review passes and relevant TinG security invariants remain true.
- [ ] Relevant tenant/security regression checks pass.
- [ ] Required database rehearsal passes.
- [ ] Required CodeRabbit review has no unresolved blocker.
- [ ] Required preview/staging verification passes.
- [ ] Preview/sandbox evidence is not misrepresented as production certification.
- [ ] Material out-of-Git configuration is documented.
- [ ] Rollback/forward-fix path is recorded for Medium/High risk.
- [ ] Material fixes made after review were re-reviewed where affected.
- [ ] This PR is **Prod Green** and safe to merge at the current head.

## Post-merge / release work

- Production verification required: **No / Yes — describe:**
- If verification fails: **Contain / Roll back / Reviewed forward-fix**
- Final production status: **Not deployed / Released / Contained / Rolled Back / Forward Fixed / Stable**
- Evidence / follow-up:
