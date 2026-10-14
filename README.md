# TinG

TinG is SupportYeti's hospitality orchestration platform. The current core sequence is ordering → payments → D-Day reliability/security hardening → first real venue.

## Sources of truth

Use the source closest to the decision being made:

1. **TinG Product OS (Notion)** — product direction, sequencing, product decisions and durable ideas.
2. **TinG Engineering Handbook (Notion)** — engineering execution, architecture, QA, verification and implementation evidence.
3. **This GitHub repository** — executable truth for code, migrations, branches, pull requests and releases.
4. **Supabase / production configuration** — runtime truth; material out-of-Git changes must be reconciled back into engineering records.

Product intent must not be inferred from code alone. When the sources disagree, verify execution/runtime truth first, then reconcile higher-level documentation.

## Repository map

- `index.html` — guest-facing application shell.
- `admin.html` — authenticated venue administration workspace.
- `auth.html`, `reset-password.html` — authentication lifecycle surfaces.
- `ting11b-cart.js` — guest ordering/cart behavior.
- `ting11c-order-board.js` — venue order-board behavior.
- `supabase/migrations/` — forward database migrations.
- `supabase/baseline/` — verified database baseline and restore/rehearsal tooling.
- `tests/` — static, contract and regression checks.
- `.github/workflows/` — CI gates.
- `docs/` — reviewed implementation/release records and current design documents.

## Engineering rules

- Reliability and security outrank novelty.
- Tenant ownership, order state, price/totals and financial state remain server/database authoritative.
- Keep payment and fulfilment state machines separate.
- Prefer small, reviewable branches and PRs with explicit verification evidence.
- Never treat a preview deployment or happy-path demo as production certification.
- Do not delete or rename historical branches/files solely for tidiness; follow `docs/REPOSITORY-GOVERNANCE.md`.

## Current payments boundary

`main` contains the PAY-1 split-aware payment foundation and PAY-1 hardening. Processor integration is developed separately and must remain sandbox/test-only until its release gates, environment configuration, reconciliation evidence and production approval are complete.

See `docs/PAYMENTS-V1-DESIGN.md` for the payment domain model and `docs/REPOSITORY-GOVERNANCE.md` for repository workflow.