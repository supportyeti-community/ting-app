import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../ting11b-cart.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

assert(index.includes('<script src="ting11b-cart.js"></script>'), 'customer page must load the TING-11B cart module');
assert(source.includes("supabaseInstance.rpc('submit_order'"), 'customer module must submit through submit_order RPC');
assert(source.includes('p_table_number: tableNumber'), 'table context must be passed to submit_order');
assert(source.includes('p_client_request_id: requestId'), 'client request id must support idempotent retries');
assert(source.includes('p_items: orderItems'), 'cart lines must be submitted as p_items');
assert(source.includes("menu_item_id: item.id"), 'RPC payload must reference canonical menu item ids');
assert(source.includes('quantity: item.quantity'), 'RPC payload must contain item quantities');
assert(!source.includes('p_tenant_id'), 'customer must never choose tenant_id');
assert(!source.includes('p_total'), 'customer must never submit authoritative totals');
assert(!source.includes('p_price'), 'customer must never submit authoritative prices');
assert(source.includes(".eq('tenant_id', tenantId)"), 'menu hydration must remain route-tenant scoped');
assert(source.includes('is_out_of_stock'), 'customer add flow must respect stock state');
assert(source.includes("String(error.code || '').startsWith('23')"), 'database validation errors must fail without blind retry');
assert(source.includes('const requestId = crypto.randomUUID();'), 'each checkout attempt must create one idempotency key');
assert(source.includes("logTelemetryAnalyticsEvent('order_submitted'"), 'successful order submission should emit telemetry');
assert(source.includes('Final pricing and availability are revalidated by TinG'), 'UI must communicate that cart totals are estimates');
assert(source.includes('observer.observe(wrapper, { childList: true });'), 'menu observer must watch only direct menu replacement mutations');
assert(!source.includes('subtree: true'), 'cart observer must not recursively observe its own card-control mutations');

console.log('PASS: TING-11B customer page loads a non-recursive cart that submits only menu ids/quantities through the route-bound idempotent order RPC');
