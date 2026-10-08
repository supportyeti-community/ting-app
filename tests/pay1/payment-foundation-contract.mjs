import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../supabase/migrations/20261008110500_pay1_payment_foundation.sql', import.meta.url), 'utf8');

const must = (needle, label) => assert(sql.includes(needle), label);
const mustNot = (needle, label) => assert(!sql.includes(needle), label);

must("ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid'", 'orders must gain independent payment status');
must("CHECK (payment_status IN ('unpaid','partially_paid','paid'))", 'payment status must be constrained');

must('CREATE TABLE public.payment_attempts', 'payment attempts table required');
must('CREATE TABLE public.payment_allocations', 'payment allocations table required');
must('UNIQUE (tenant_id, client_request_id)', 'TinG payment request idempotency required');
must('UNIQUE (payment_attempt_id)', 'v1 must allocate at most once per successful attempt');
must('FOREIGN KEY (tenant_id, order_id)', 'payment rows must be structurally tenant/order coupled');
must('FOREIGN KEY (tenant_id, payment_attempt_id)', 'allocations must be structurally tenant/attempt coupled');
must('reservation_expires_at timestamptz NOT NULL', 'pending reservations need bounded lifetime');
must("WHERE status IN ('created','pending')", 'only active attempts reserve money');

must('ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY', 'attempts require RLS');
must('ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY', 'allocations require RLS');
must('REVOKE ALL ON public.payment_attempts FROM PUBLIC, anon, authenticated', 'browser direct attempt writes must be denied');
must('REVOKE ALL ON public.payment_allocations FROM PUBLIC, anon, authenticated', 'browser direct allocation writes must be denied');
must('ting_private.can_manage_tenant(tenant_id)', 'staff reads must use tenant membership authority');

must('CREATE OR REPLACE FUNCTION ting_private.create_payment_attempt', 'trusted create-attempt implementation required');
must('routed_tenant_id := ting_private.request_tenant_id()', 'customer route must resolve tenant server-side');
must('SELECT * INTO balance', 'attempt creation must derive current balance');
must('ting_private.payment_balance(p_order_id, routed_tenant_id, true)', 'attempt creation must lock the canonical order balance');
must("normalized_amount > balance.amount_available", 'attempt must reject over-reservation');
must("now() + interval '10 minutes'", 'reservation expiry must be bounded');
must('WHERE tenant_id = routed_tenant_id\n    AND client_request_id = p_client_request_id', 'retries must resolve the original attempt');

must('CREATE OR REPLACE FUNCTION public.get_order_payment_balance', 'customer needs narrow balance read contract');
must('amount_paid numeric(12,2)', 'balance contract must expose derived paid amount');
must('amount_reserved numeric(12,2)', 'balance contract must expose active reservations');
must('amount_available numeric(12,2)', 'balance contract must expose spendable remainder');

must('CREATE OR REPLACE FUNCTION ting_private.confirm_payment_attempt', 'trusted confirmation primitive required');
must("IF attempt.status = 'succeeded' THEN", 'confirmation must be replay-safe');
must("confirmed amount mismatch", 'processor amount mismatch must fail closed');
must("currency mismatch", 'processor currency mismatch must fail closed');
must("IF paid + normalized_amount > order_total THEN", 'recognized money must never exceed canonical order total');
must('ON CONFLICT (payment_attempt_id) DO NOTHING', 'duplicate success must not double allocate');
must("WHEN paid < total THEN 'partially_paid'", 'partial allocation must derive partially_paid');
must("ELSE 'paid'", 'full allocation must derive paid');

mustNot('orders.payment_id', 'one-order-one-payment model is forbidden');
mustNot('p_tenant_id uuid,\n  p_requested_amount', 'public customer attempt contract must not accept tenant_id');
mustNot('GRANT INSERT ON public.payment_attempts', 'browser must never directly insert attempts');
mustNot('GRANT INSERT ON public.payment_allocations', 'browser must never directly insert allocations');

console.log('PASS: PAY-1 split-aware payment foundation preserves tenant authority, idempotency, bounded reservations, server-confirmed allocation, and derived order balance');
