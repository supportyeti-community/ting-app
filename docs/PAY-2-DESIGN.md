# PAY-2 — Stripe sandbox processor adapter

Status: repository design/implementation only until explicitly approved for deployment/configuration.

## Goal

Connect PAY-1's split-aware payment attempts to Stripe test mode without making the browser authoritative for money movement.

## Mapping

- One TinG `order` may have many `payment_attempts`.
- One Stripe PaymentIntent maps to exactly one TinG `payment_attempt`.
- A PaymentIntent amount is derived from the canonical `payment_attempt.requested_amount`, never from browser-provided price/total metadata.
- TinG stores currency as AUD in PAY-2; Stripe receives the amount in cents.
- Stripe metadata contains TinG identifiers only for correlation. Metadata is never authorization.

## State boundary

`created` — balance reserved in TinG, no processor object is trusted yet.

`pending` — a Stripe PaymentIntent is bound to the attempt. A pending attempt must NOT be auto-expired by database-only cleanup because Stripe may still succeed.

`succeeded` — a verified Stripe webhook has reconciled the exact expected amount/currency/provider reference and created one payment allocation.

`failed` / `cancelled` / `expired` — terminal state releases the reservation. For processor-bound attempts, TinG only reaches a releasing terminal state after the server has observed a Stripe terminal event or has successfully cancelled the PaymentIntent.

## Endpoints

### `POST /api/payments/create-intent`

Input:
- `order_id`
- `requested_amount`
- `client_request_id`
- tenant route via `x-client-slug`

Flow:
1. clean up expired processor-bound reservations for the target order by cancelling Stripe PaymentIntents before releasing TinG reservations;
2. call route-bound PAY-1 `create_payment_attempt` using the anon role;
3. create/reuse one Stripe PaymentIntent using a server-side Stripe idempotency key derived from the canonical attempt id;
4. bind the provider reference to that canonical attempt through a service-role-only RPC;
5. return only the PaymentIntent client secret plus canonical payment-attempt/balance information needed by the UI.

### `POST /api/payments/stripe-webhook`

Flow:
1. read raw request body;
2. verify Stripe signature using `STRIPE_WEBHOOK_SECRET`;
3. ignore unsupported event types;
4. for `payment_intent.succeeded`, reconcile through a service-role-only RPC using the canonical attempt id in metadata, provider PaymentIntent id, `amount_received`, and currency;
5. for `payment_intent.payment_failed` / `payment_intent.canceled`, transition the canonical attempt to the matching releasing terminal state;
6. make webhook replay harmless.

## Required secrets

Vercel sensitive/encrypted variables, never committed:
- `STRIPE_SECRET_KEY` (test-mode key during PAY-2 certification)
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

No live Stripe secret is required for PAY-2 sandbox certification.

## Safety invariants

1. Browser never sends or controls tenant id, canonical amount in cents, provider id, allocation amount, or payment success state.
2. `x-client-slug` selects a route; canonical tenant ownership still comes from Supabase route resolution.
3. Stripe metadata is correlation data, not authorization.
4. Webhook signature must verify before any trusted reconciliation call.
5. A successful attempt allocates exactly once.
6. A webhook amount/currency/provider mismatch fails closed.
7. Pending processor-bound attempts are not released by DB-only expiry.
8. A stale processor-bound attempt is cancelled at Stripe before TinG releases its reserved balance.
9. Full and split payments use the same primitive; split is multiple attempts against one order.
10. PAY-2 sandbox uses Stripe test mode only until a separate live-payments approval.
