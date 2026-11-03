import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../../api/payments/create-intent.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../../lib/payments-server.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261015020000_pay2_current_main_recovery.sql', import.meta.url), 'utf8');
const confirmationHardening = readFileSync(new URL('../../supabase/migrations/20261031104500_pay2_unbound_confirmation_account_check.sql', import.meta.url), 'utf8');
const webhook = readFileSync(new URL('../../api/payments/stripe-webhook.js', import.meta.url), 'utf8');

assert(api.includes("fn: 'authorize_order_payment_context'"), 'payment API must authorize canonical order/table context first');
assert(api.includes('p_table_token: tableToken'), 'payment API must pass the table bearer token');
assert(api.includes("fn: 'create_payment_attempt'"), 'payment API must reserve through the canonical payment RPC');

const authorizeIndex = api.indexOf("fn: 'authorize_order_payment_context'");
const cleanupIndex = api.indexOf('cleanupStaleStripeAttempts(orderId, stripe)');
const createAttemptIndex = api.indexOf("fn: 'create_payment_attempt'");
assert(authorizeIndex >= 0 && cleanupIndex > authorizeIndex, 'service-role stale cleanup must happen only after guest table authorization');
assert(createAttemptIndex > cleanupIndex, 'payment attempt reservation must follow authorized stale cleanup');

assert(migration.includes('ting_private.table_access_context_is_valid'), 'database payment authorization must reuse the canonical table capability validator');
assert(migration.includes('SELECT o.table_number INTO canonical_table'), 'database must derive the table from the canonical order');
assert(migration.includes('valid table access context required for payment'), 'invalid or missing table capability must fail closed');
assert(migration.includes('CREATE OR REPLACE FUNCTION public.create_payment_attempt('), 'public payment reservation RPC must be recreated');
assert(migration.includes('p_table_token text DEFAULT NULL'), 'public payment reservation must accept the capability token');
assert(!migration.includes('GRANT EXECUTE ON FUNCTION public.bind_payment_provider(uuid,text,text,text) TO anon'), 'provider binding must never be guest-callable');
assert(!migration.includes('GRANT EXECUTE ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,text,numeric,text) TO anon'), 'trusted reconciliation must never be guest-callable');

assert(confirmationHardening.includes('attempt.provider_payment_id IS NULL AND NOT EXISTS'), 'unbound confirmation must require an active canonical tenant payment account');
assert(confirmationHardening.includes('a.tenant_id=attempt.tenant_id'), 'unbound confirmation must bind the Stripe account to the attempt tenant');
assert(confirmationHardening.includes('a.provider_account_id=normalized_account'), 'unbound confirmation must match the connected account from Stripe');

assert(server.includes("role === 'anon' ? anonKey : serviceKey"), 'server helper must separate anon and service credentials');
assert(server.includes('stripeAccount'), 'Stripe operations must be connected-account scoped');
assert(server.includes("intent.status === 'processing' || intent.status === 'requires_capture'"), 'stale cleanup must preserve processor-owned non-cancellable states');
assert(webhook.includes('stripe.webhooks.constructEvent'), 'webhook must verify Stripe signature against the raw body');
assert(webhook.includes('event.account'), 'Connect webhook must require connected-account context');
assert(webhook.includes('if (event.livemode)'), 'sandbox webhook must reject live-mode events');
assert(webhook.includes("case 'payment_intent.payment_failed':\n        // A failed attempt can still be retryable"), 'payment_failed webhook must preserve retryability instead of cancelling the intent');
assert(!webhook.includes('cancelFailedIntent'), 'payment_failed webhook must not cancel from an event snapshot');

console.log('PASS: PAY-2 payment initiation and Stripe reconciliation remain tenant/order/table/account bound');
