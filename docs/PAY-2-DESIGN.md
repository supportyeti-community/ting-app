# PAY-2 — Stripe Connect sandbox processor adapter

Status: repository design/implementation only until explicitly approved for deployment/configuration.

## Goal

Connect PAY-1's split-aware payment attempts to Stripe Connect sandbox/test mode without making the browser authoritative for money movement and without making SupportYeti the merchant collecting restaurant revenue.

## Connect model

PAY-2 uses **Stripe Connect direct charges**.

- Each TinG tenant/restaurant maps to one Stripe connected account.
- Stripe-hosted onboarding is the preferred onboarding path; TinG does not collect KYC documents itself.
- One TinG `order` may have many `payment_attempts`.
- One Stripe PaymentIntent maps to exactly one TinG `payment_attempt`.
- Each PaymentIntent is created directly on the restaurant's connected account.
- The restaurant connected account is resolved server-side from canonical tenant ownership. The browser never supplies or selects a Stripe account id.
- A PaymentIntent amount is derived from the canonical `payment_attempt.requested_amount`, never from browser-provided price/total metadata.
- TinG stores currency as AUD in PAY-2; Stripe receives the amount in cents.
- Stripe metadata contains TinG identifiers only for correlation. Metadata is never authorization.
- `payment_attempts.provider_account_id` snapshots the connected Stripe account used for that processor attempt so webhook reconciliation can fail closed if the Connect account does not match.

This keeps TinG as the orchestration and ledger layer while the restaurant remains the seller receiving its own Stripe payments. Platform-fee monetisation is deferred until the base direct-charge path is certified.

## Tenant payment-account mapping

`tenant_payment_accounts` stores the provider account bound to each tenant.

For PAY-2:
- provider = `stripe`
- one active Stripe account per tenant
- `provider_account_id` is server-managed and never writable by anon/authenticated clients
- payment creation requires an active mapping
- a Connect account mismatch between TinG, Stripe request context, or webhook event fails closed

PAY-2 does not store KYC documents, bank details, card details, or Stripe secret keys in Supabase.

## State boundary

`created` — balance reserved in TinG, no processor object is trusted yet.

`pending` — a Stripe PaymentIntent is bound to the attempt together with its Stripe connected-account id. A pending attempt must NOT be auto-expired by database-only cleanup because Stripe may still succeed.

`succeeded` — a verified Stripe Connect webhook has reconciled the exact expected connected account, amount, currency, and provider reference and created one payment allocation.

`failed` / `cancelled` / `expired` — terminal state releases the reservation. For processor-bound attempts, TinG only reaches a releasing terminal state after the server has observed a Stripe terminal event or has successfully cancelled the PaymentIntent in the same connected-account context.

## Endpoints

### `POST /api/payments/create-intent`

Input:
- `order_id`
- `requested_amount`
- `client_request_id`
- tenant route via `x-client-slug`

Flow:
1. call route-bound PAY-1 `create_payment_attempt` using the anon role;
2. resolve the tenant's active Stripe connected account server-side from the canonical attempt tenant;
3. clean up stale processor-bound reservations using each attempt's stored connected-account context, cancelling Stripe PaymentIntents before releasing TinG reservations;
4. create/reuse one Stripe PaymentIntent **as a direct charge on that connected account** using a server-side Stripe idempotency key derived from the canonical attempt id;
5. bind both provider PaymentIntent id and provider connected-account id to the canonical attempt through a service-role-only RPC;
6. return only the PaymentIntent client secret plus canonical payment-attempt/balance information needed by the UI.

### `POST /api/payments/stripe-webhook`

The Stripe endpoint must be configured for **events on connected accounts**.

Flow:
1. read raw request body;
2. verify Stripe signature using `STRIPE_WEBHOOK_SECRET`;
3. reject live-mode events during PAY-2 sandbox certification;
4. require Stripe's Connect `event.account` and match it against the canonical attempt's stored provider account;
5. ignore unsupported event types;
6. for `payment_intent.succeeded`, reconcile through a service-role-only RPC using canonical attempt id, connected-account id, provider PaymentIntent id, `amount_received`, and currency;
7. for `payment_intent.payment_failed` / `payment_intent.canceled`, transition the canonical attempt to the matching releasing terminal state in that same connected-account context;
8. make webhook replay harmless.

## Required secrets

Vercel sensitive/encrypted variables, never committed:
- `STRIPE_SECRET_KEY` (Connect platform sandbox/test secret during PAY-2 certification)
- `STRIPE_WEBHOOK_SECRET` (Connect webhook signing secret)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

No live Stripe secret is required for PAY-2 sandbox certification.

## Safety invariants

1. Browser never sends or controls tenant id, connected Stripe account id, canonical amount in cents, provider PaymentIntent id, allocation amount, or payment success state.
2. `x-client-slug` selects a route; canonical tenant ownership still comes from Supabase route resolution.
3. Stripe metadata is correlation data, not authorization.
4. Stripe connected-account context is canonical server-side state and must match on create, retrieve, cancel, and webhook reconciliation.
5. Webhook signature must verify before any trusted reconciliation call.
6. A successful attempt allocates exactly once.
7. A webhook account/amount/currency/provider mismatch fails closed.
8. Pending processor-bound attempts are not released by DB-only expiry.
9. A stale processor-bound attempt is cancelled in its Stripe connected account before TinG releases its reserved balance.
10. Full and split payments use the same primitive; split is multiple attempts against one order.
11. PAY-2 sandbox uses Stripe sandbox/test mode only until a separate live-payments approval.
12. PAY-2 V1 does not use destination charges or separate charges/transfers.
13. PAY-2 V1 does not introduce a SupportYeti wallet, stored balance, or custody layer.
