# TinG

TinG is SupportYeti's hospitality operations and orchestration platform. **The founder-approved Pilot v1 sequence (4 November 2026)** is secure guest ordering → reliable Floor/Admin operations → traditional venue-managed pay-at-counter settlement → pilot-specific security/recovery verification → first controlled real venue. Integrated online payments are optional and deferred, not a prerequisite for the first pilot.

**Product authority:** [TinG Product Decision Log](https://app.notion.com/p/3f927a720673813ba7eef709739faf4d) · [Pilot v1 engineering assessment (GitHub #49)](https://github.com/supportyeti-community/ting-app/issues/49) · [Canonical work item](https://app.notion.com/p/40e27a7206738136948ae6cb69420748). This is an adopted product direction, **not** a claim that the pilot is implemented or release-certified.

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

## Pilot v1 payment boundary — traditional counter settlement

For the first controlled venue pilot, guests submit verified table-linked orders; venue staff manage preparation and service; guests pay with the venue's existing EFTPOS/cash at the counter. TinG must track orders and outstanding bills, keep fulfilment and settlement states separate, and restrict external-payment confirmation and bill closure to authorised staff. **These pilot-specific capabilities remain subject to implementation audit and verification; do not assume they exist on `main`.**

`main` contains the PAY-1 split-aware payment foundation and hardening. PAY-1/PAY-2 implementations and evidence are preserved. PAY-2 production migration/rollout, live Stripe configuration, live payments and guest online-payment UI remain **HOLD** under the existing [PAY-2 production release gates](https://app.notion.com/p/40c27a720673817e96d3c9705653ffe3). No production execution or payment activation has been authorised. Do not classify staff-recorded counter settlement as processor-certified payment.

Default to **zero incremental infrastructure spend** for the pilot unless explicitly approved. Orchestrator v2 unattended paid coding execution remains HOLD.

Historical documentation describing payments-before-first-venue is superseded for Pilot v1 product sequencing only; it remains historical engineering context, not permission to bypass security or recovery gates.

See `docs/PAYMENTS-V1-DESIGN.md` for the payment domain model and `docs/REPOSITORY-GOVERNANCE.md` for repository workflow.