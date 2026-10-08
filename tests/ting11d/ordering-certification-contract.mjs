import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cart = readFileSync(new URL('../../ting11b-cart.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('../../ting11c-order-board.js', import.meta.url), 'utf8');
const rehearsal = readFileSync(new URL('../../supabase/baseline/native/ting11.mjs', import.meta.url), 'utf8');

// Customer-side resilience / idempotency
assert(cart.includes('if (submitting || !cart.size || !orderContextAvailable()) return;'), 'double-submit guard must remain fail-closed');
assert(cart.includes('const requestId = crypto.randomUUID();'), 'checkout must create exactly one request id per submission attempt');
assert(cart.includes("p_client_request_id: requestId"), 'network retries must reuse the same idempotency key');
assert(cart.includes('for (let attempt = 0; attempt < retries; attempt++)'), 'submission retry loop must remain bounded');
assert(cart.includes("String(error.code || '').startsWith('23')"), 'database validation failures must not be blindly retried');
assert(cart.includes(".eq('tenant_id', tenantId)"), 'menu item refresh must be tenant scoped');
assert(cart.includes('data.is_out_of_stock'), 'stale/out-of-stock items must be rejected before add when detected client-side');
assert(!cart.includes('p_tenant_id'), 'customer may never choose order tenant');
assert(!cart.includes('p_price'), 'customer may never choose authoritative price');
assert(!cart.includes('p_total'), 'customer may never choose authoritative total');

// Restaurant board isolation / lifecycle authority
assert(board.includes(".from('orders')"), 'order board must read canonical orders');
assert(board.includes(".from('order_items')"), 'order board must read canonical order items');
const tenantReadScopes = board.match(/\.eq\('tenant_id', tenantId\)/g) || [];
assert(tenantReadScopes.length >= 2, 'orders and order_items reads must both be tenant scoped');
assert(board.includes(".channel(`orders:${tenantId}`)"), 'realtime channel name must be tenant scoped');
const realtimeFilters = board.match(/filter: `tenant_id=eq\.\$\{tenantId\}`/g) || [];
assert(realtimeFilters.length >= 2, 'INSERT and UPDATE realtime subscriptions must both be tenant filtered');
assert(board.includes("supabaseInstance.rpc('advance_order_status'"), 'status changes must go through lifecycle RPC');
assert(!board.includes(".from('orders').update("), 'admin browser must never directly update orders');
assert(board.includes("const ACTIVE_STATUSES = ['submitted', 'accepted', 'preparing', 'ready'];"), 'completed orders must remain outside active queue');
assert(board.includes("ready: { next: 'completed', label: 'Complete Order' }"), 'board lifecycle must terminate through completed');

// Native behavioral certification must keep proving the trust boundary.
const requiredNativeProofs = [
  'Idempotent retry returns original order without duplicates',
  'Cross-tenant, out-of-stock, and malformed-table submissions fail closed',
  'Composite parent-order FK blocks cross-tenant child drift',
  'Membership, not routed slug, controls order visibility',
  'Only submitted -> accepted -> preparing -> ready -> completed is allowed',
  'Membership revocation immediately removes order visibility and lifecycle authority'
];
for (const proof of requiredNativeProofs) {
  assert(rehearsal.includes(proof), `native TING-11 rehearsal must retain proof: ${proof}`);
}

console.log('PASS: TING-11D ordering certification preserves idempotency, stale-stock failure, tenant isolation, RPC-only lifecycle authority, and realtime tenant scoping across customer/admin layers');
