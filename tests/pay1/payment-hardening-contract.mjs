import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../supabase/migrations/20261008112000_pay1_hardening.sql', import.meta.url), 'utf8');

assert.match(sql, /CREATE OR REPLACE FUNCTION public\.get_order_payment_balance\(p_order_id uuid\)/);
assert.match(sql, /LANGUAGE sql/);
assert.match(sql, /SECURITY INVOKER/);
assert.doesNotMatch(sql, /SECURITY DEFINER/);
assert.match(sql, /ting_private\.payment_balance\(/);
assert.match(sql, /ting_private\.request_tenant_id\(\)/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_order_payment_balance\(uuid\)[\s\S]*TO anon, authenticated/);
assert.match(sql, /CREATE INDEX payment_allocations_tenant_attempt_idx[\s\S]*ON public\.payment_allocations \(tenant_id, payment_attempt_id\)/);
assert.match(sql, /SET search_path = ''/);

console.log('PASS: PAY-1 public payment balance wrapper is SECURITY INVOKER and route-bound');
console.log('PASS: PAY-1 composite allocation/attempt foreign key has a covering index');
