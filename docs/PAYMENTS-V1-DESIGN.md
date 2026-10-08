# TinG — Payments v1 Design

Status: **Design only — no production mutation**

Base: Ordering v1 production-certified at `f35c9ec6f2d59eeb6c2c2fbf79f5b4216aa18d97`

## 1. Product intent

TinG should provide a native restaurant payment experience without becoming a payment processor.

TinG owns:
- the restaurant order and outstanding balance;
- full and partial payment orchestration;
- split-bill UX;
- payment state shown to diners and staff;
- idempotency and concurrency control;
- reconciliation of processor-confirmed payments back to an order;
- tenant isolation and authorization.

The processor owns:
- card and wallet details;
- tokenisation;
- network authorization/capture;
- PCI-sensitive payment handling;
- processor fraud controls;
- settlement, disputes and chargeback rails.

The browser is never authoritative for whether money moved. Processor-confirmed server-side events are authoritative.

---

## 2. North-star invariant

> **An order has a balance. Successful payment allocations reduce that balance. No single payment owns the order.**

Do **not** model Payments v1 as `orders.payment_id`.

One order may have zero, one or many payment attempts and successful payment allocations.

This is required for:
- one diner paying the whole order;
- equal bill splits;
- custom partial payments;
- multiple diners paying from different phones;
- failed/retried attempts;
- future refunds and item-level allocation without rewriting the order model.

---

## 3. Scope

### Payments v1 includes
- pay the full outstanding amount;
- equal split by number of diners;
- custom partial amount;
- multiple devices contributing to one order;
- live outstanding-balance refresh;
- processor-backed card / wallet payment flow;
- payment attempt idempotency;
- server-side processor webhook confirmation;
- order payment status: `unpaid`, `partially_paid`, `paid`;
- restaurant-side visibility of amount paid / due;
- safe handling of concurrent payments that would otherwise overpay the order.

### Payments v1 does not include
- split by individual menu item;
- assigning dishes to named diners;
- shared-item fraction allocation;
- tips;
- loyalty;
- gift cards;
- restaurant subscriptions;
- cash drawer accounting;
- terminal/EFTPOS device integration;
- refunds UI;
- chargeback management UI;
- settlement/payout reconciliation UI.

The schema must leave room for those later without making them necessary now.

---

## 4. Proposed data model

All monetary values should use the same fixed-precision numeric convention already used by `orders` and must be non-negative.

### 4.1 `payment_attempts`

Represents one processor payment intent/session/attempt initiated by TinG.

Proposed fields:

- `id uuid primary key`
- `tenant_id uuid not null`
- `order_id uuid not null`
- `provider text not null`
- `provider_payment_id text null`
- `client_request_id uuid not null`
- `requested_amount numeric(12,2) not null`
- `currency text not null default 'AUD'`
- `status text not null`
- `failure_code text null`
- `failure_message text null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- `confirmed_at timestamptz null`
- `cancelled_at timestamptz null`

Suggested status set:

`created -> pending -> succeeded`

Terminal alternatives:

`failed | cancelled`

Constraints:
- unique `(tenant_id, client_request_id)`;
- unique provider reference where non-null;
- composite tenant/order coupling to prevent cross-tenant drift;
- `requested_amount > 0`.

### 4.2 `payment_allocations`

Represents money that TinG is allowed to count toward an order balance.

This table deliberately separates **processor attempts** from **recognized money**.

Proposed fields:

- `id uuid primary key`
- `tenant_id uuid not null`
- `order_id uuid not null`
- `payment_attempt_id uuid not null`
- `amount numeric(12,2) not null`
- `currency text not null default 'AUD'`
- `created_at timestamptz not null`

Constraints:
- one allocation per successful attempt in v1;
- composite tenant/order/payment coupling;
- `amount > 0`;
- allocation cannot exceed the processor-confirmed captured/succeeded amount.

Keeping this separate makes future partial refunds, multi-order allocation, tips and item-level accounting possible without changing the meaning of `payment_attempts`.

### 4.3 `orders` additions

Proposed additions:

- `payment_status text not null default 'unpaid'`

Allowed values:
- `unpaid`
- `partially_paid`
- `paid`

Do **not** persist browser-supplied `amount_paid` or `amount_due`.

Preferred model:
- `amount_paid` is derived from successful `payment_allocations`;
- `amount_due = greatest(order.total - amount_paid, 0)`;
- `payment_status` is maintained transactionally from those server-derived values.

If performance later requires cached amounts, they must remain server-maintained derived state, never client-authoritative state.

---

## 5. Balance semantics

For an order total of `$120.00`:

Initial:
- paid = `$0.00`
- due = `$120.00`
- status = `unpaid`

Diner A pays `$40.00`:
- paid = `$40.00`
- due = `$80.00`
- status = `partially_paid`

Diner B pays `$50.00`:
- paid = `$90.00`
- due = `$30.00`
- status = `partially_paid`

Diner C pays `$30.00`:
- paid = `$120.00`
- due = `$0.00`
- status = `paid`

TinG must never mark the order paid because the browser reports success. It becomes paid only after server-side confirmation and allocation.

---

## 6. Split-bill UX contract

When the order is eligible for payment, customer UI shows:

- **Pay full balance**
- **Split bill**

Split bill v1 offers:

### Equal split
User selects number of people, e.g. `2 / 3 / 4 / custom count`.

TinG computes the suggested share from the **current outstanding balance**, not the original order total.

Example: outstanding `$100`, 3-way split.
- share suggestions may be `$33.33`, `$33.33`, `$33.34` conceptually;
- however, each device only needs to request a valid amount and the final remaining diner always sees the live exact remainder.

We do not need persistent “seat 1 / seat 2 / seat 3” identities in v1.

### Custom amount
Diner enters an amount up to the currently available balance.

UI always shows:
- order total;
- amount already paid;
- remaining balance;
- amount this diner is about to pay.

---

## 7. Multi-device concurrency

This is a first-class Payments v1 requirement.

Example failure case to prevent:
- remaining balance is `$30`;
- Device A starts a `$30` payment;
- Device B simultaneously starts another `$30` payment;
- both are authorized;
- TinG accidentally collects `$60` against `$30` due.

### Required design

TinG must introduce a server-side reservation/claim step before creating a processor payment.

Conceptual flow:

1. Client requests `create_payment_attempt(order_id, requested_amount, client_request_id)`.
2. Server resolves tenant from trusted request context.
3. Server locks/reconciles the order balance transactionally.
4. Server rejects any request that exceeds the currently payable balance.
5. Server creates/records one pending payment attempt.
6. Processor payment is created using the server-approved amount.
7. Other devices refetch and see the latest payable state.

A production implementation must also decide how long an unconfirmed pending attempt reserves money. The initial design recommendation is a short expiration window with explicit cancellation/expiry handling rather than letting abandoned payment attempts block the bill indefinitely.

Exact reservation mechanics belong in the implementation design before schema execution.

---

## 8. Idempotency

There are two separate idempotency boundaries.

### TinG request idempotency
Browser generates one `client_request_id` per payment attempt.

Retries reuse the same key.

Unique constraint:

`(tenant_id, client_request_id)`

A retry must return the original attempt rather than create another attempt.

### Processor idempotency
Server adapter supplies an idempotency key to the processor based on the TinG payment attempt ID/client request ID.

A transport retry must not create a second external charge/payment intent.

---

## 9. Processor abstraction

TinG should not use provider-specific column names as its domain model.

Preferred internal vocabulary:
- provider
- provider_payment_id
- payment attempt
- requested amount
- confirmed amount
- payment status

Provider-specific code should sit behind a small server-side adapter, conceptually:

- `createPayment(...)`
- `retrievePayment(...)`
- `cancelPayment(...)`
- `verifyWebhook(...)`

Stripe can be the first adapter without making Stripe the architecture.

No secret processor key may ever be shipped to customer/admin JavaScript.

---

## 10. Authority model

### Customer browser may choose
- canonical `order_id` visible through the routed table/order experience;
- desired payment mode;
- desired amount, subject to current balance;
- one client request UUID.

### Customer browser may not choose
- `tenant_id`;
- authoritative outstanding balance;
- authoritative amount already paid;
- payment success;
- processor capture status;
- provider event identity;
- order payment status.

### TinG server/database owns
- tenant derivation;
- order ownership;
- current payable balance;
- requested amount validation;
- payment attempt creation;
- allocation recognition;
- order payment-status transition.

### Processor owns
- payment-method data;
- authorization/capture result;
- signed event provenance.

---

## 11. Webhook authority

Processor success must be reconciled by a server-side webhook/verified callback.

Conceptual flow:

`processor event -> verify signature -> locate payment attempt -> transactionally mark succeeded -> insert allocation -> recompute order payment status`

Requirements:
- webhook event deduplication;
- safe replay handling;
- unknown provider references fail closed;
- amount/currency mismatch fails closed and is surfaced for operator review;
- tenant comes from the stored payment attempt, never webhook client metadata alone;
- duplicate success events cannot allocate money twice.

The browser success screen may optimistically say “Payment processing” but should show final “Paid” only after TinG observes confirmed server state.

---

## 12. Tenant isolation

Every payment-domain row is canonical tenant-owned.

Required structural patterns should follow TING-8 / TING-11:
- `tenant_id NOT NULL`;
- composite parent/child tenant foreign keys where relevant;
- RLS enabled;
- customer cannot directly insert/update payment tables;
- customer flows use narrow RPC/server functions;
- restaurant staff visibility depends on authenticated `tenant_memberships`, not route slug;
- processor webhook uses trusted server credentials but still resolves stored tenant ownership from the attempt.

`client_slug` is routing context, never payment authorization.

---

## 13. Order lifecycle vs payment lifecycle

Ordering and payment are separate state machines.

An order may be:
- `submitted / accepted / preparing / ready / completed`

while payment may be:
- `unpaid / partially_paid / paid`

Do not overload `orders.status` with payment values.

Initial Payments v1 recommendation:
- restaurant fulfilment may continue independently from payment unless the restaurant config later chooses a “pay before preparation” policy;
- payment state is displayed separately on the order board.

A future restaurant setting can control when payment is required without changing the payment data model.

---

## 14. Failure behaviour

### Payment fails
- attempt becomes `failed`;
- no allocation is created;
- outstanding balance remains unchanged;
- diner can retry with a new client request ID.

### Browser closes after processor success
- webhook still finalizes allocation;
- another device/admin sees the correct paid balance.

### Webhook arrives twice
- second event is a no-op.

### User refreshes during payment
- current attempt can be recovered by request/attempt identity if appropriate;
- no new charge should be inferred from refresh.

### Menu/order total changes after payment begins
Orders are already snapshot-based. Payments operate against the canonical stored order total/outstanding balance, not current menu pricing.

---

## 15. Refund-ready design without building refunds v1

Payments v1 does not need a refund UI, but the model must avoid assumptions that block it.

Future refund records should be able to reference:
- tenant;
- payment attempt/allocation;
- processor refund reference;
- amount;
- status;
- reason;
- timestamps.

Future net-paid calculation can become:

`successful allocations - successful refunds`

No Payments v1 table should need destructive reinterpretation to support this.

---

## 16. Security / compliance boundary

TinG must not store raw:
- PAN/card number;
- CVV/CVC;
- wallet credentials;
- full sensitive payment-method payloads.

Use processor-hosted/embedded secure payment components so sensitive payment details flow directly to the processor.

TinG stores only the minimum processor references and non-sensitive reconciliation metadata required to operate the product.

---

## 17. Recommended implementation slices

### PAY-1 — payment foundation
- payment schema;
- balance derivation;
- payment-status state machine;
- tenant coupling;
- RPC/server contracts;
- native isolation/idempotency tests.

### PAY-2 — processor adapter + sandbox
- first provider adapter (likely Stripe, subject to provider review);
- secret/server configuration;
- create payment flow;
- verified webhook;
- sandbox-only behavioural certification.

### PAY-3 — customer payment UI
- Pay full;
- Split bill;
- equal/custom amount;
- secure embedded processor component;
- pending/success/failure UX;
- live remaining balance.

### PAY-4 — admin payment visibility
- unpaid / partially paid / paid badge;
- paid and due amounts;
- realtime/refetch updates;
- no manual browser authority over payment completion.

### PAY-5 — concurrency + production certification
- multi-device simultaneous payment tests;
- duplicate webhook/retry tests;
- abandoned reservation expiry tests;
- cross-tenant payment isolation;
- sandbox -> controlled production payment certification.

---

## 18. Acceptance criteria for Payments v1

Payments v1 is not Done until all of the following are certified:

1. One diner can pay a full order.
2. Multiple diners can partially pay the same order from different devices.
3. Equal/custom split amounts never permit recognized payments above the outstanding balance.
4. A duplicated browser request does not create a duplicate TinG payment attempt.
5. A processor/API retry does not create a duplicate external payment.
6. A duplicated webhook cannot allocate money twice.
7. Payment success is server-confirmed, not browser-authoritative.
8. A tenant member can see only their restaurant’s payment/order balance data.
9. A routed slug cannot grant payment-management authority.
10. Payment failure leaves order balance unchanged.
11. Abandoned pending attempts do not permanently lock the bill.
12. The original order remains immutable as the commercial source of truth for the amount being paid.

---

## 19. Decisions locked by this design

- TinG is **not** a native payment processor.
- Payments are processor-backed but TinG-native in UX and orchestration.
- Split bills are a Payments v1 fundamental.
- One order can have many payment attempts/allocations.
- Full, equal-split and custom partial payments are v1.
- Split-by-item is deferred.
- Browser-reported success is never authoritative.
- Webhook/server confirmation is authoritative.
- Payment and fulfilment are separate state machines.
- Provider-specific details stay behind an adapter.
- Production payment mutations require a separate explicit approval gate.
