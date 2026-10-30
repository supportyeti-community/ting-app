import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../ting11c-order-board.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');

assert(admin.includes('<script src="ting11c-order-board.js"></script>'), 'admin page must load the TING-11C order board module');
assert(source.includes(".from('orders')"), 'order board must read canonical orders');
assert(source.includes(".from('order_items')"), 'order board must read canonical order items');
assert(source.includes(".eq('tenant_id', tenantId)"), 'order reads must be scoped to the routed tenant');
assert(source.includes('filter: `tenant_id=eq.${tenantId}`'), 'realtime order subscriptions must be tenant filtered');
assert(source.includes("supabaseInstance.rpc('advance_order_status'"), 'status changes must use advance_order_status RPC');
assert(source.includes('p_order_id: orderId'), 'status RPC must send canonical order id');
assert(source.includes('p_next_status: nextStatus'), 'status RPC must send requested next status');
assert(!source.includes(".from('orders').update("), 'admin must not directly update order status');
assert(!source.includes(".from(\"orders\").update("), 'admin must not directly update order status');
assert(source.includes("submitted: { next: 'accepted'"), 'submitted orders must only advance to accepted');
assert(source.includes("accepted: { next: 'preparing'"), 'accepted orders must only advance to preparing');
assert(source.includes("preparing: { next: 'ready'"), 'preparing orders must only advance to ready');
assert(source.includes("ready: { next: 'completed'"), 'ready orders must only advance to completed');
assert(source.includes(".in('status', ACTIVE_STATUSES)"), 'board should only show active lifecycle states');
assert(source.includes('item_name_snapshot'), 'board must display immutable item snapshots');
assert(source.includes('line_total'), 'board must display stored line totals');
assert(source.includes('boardInitialized'), 'module must guard against duplicate initialization');
assert(source.includes('const RECONCILE_INTERVAL_MS = 15000'), 'order board must reconcile from the database every 15 seconds');
assert(source.includes("document.addEventListener('visibilitychange', handleVisibilityChange)"), 'order board must reconcile when the dashboard becomes visible');
assert(source.includes("window.addEventListener('online', handleOnline)"), 'order board must reconcile when connectivity returns');
assert(source.includes("document.visibilityState === 'visible'"), 'visibility reconciliation must only run when the document becomes visible');
assert(source.includes('.subscribe(status =>'), 'order board must inspect realtime subscription state');
assert(source.includes("status === 'SUBSCRIBED'"), 'realtime subscription success must be detected');
assert(source.includes("if (status === 'SUBSCRIBED') refreshOrderBoard()"), 'realtime reconnect must reconcile from authoritative database state');
assert(source.includes("setBoardHealth('degraded')"), 'failed authoritative refreshes must expose degraded state');
assert(source.includes('lastSuccessfulRefreshAt'), 'board must track the last successful authoritative refresh');
assert(source.includes("document.removeEventListener('visibilitychange', handleVisibilityChange)"), 'visibility listener must be cleaned up');
assert(source.includes("window.removeEventListener('online', handleOnline)"), 'online listener must be cleaned up');
assert(source.includes('clearInterval(pollingTimer)'), 'polling timer must be cleaned up');

console.log('PASS: TING-11C admin order board is tenant-scoped, realtime-assisted, reconciles every 15 seconds and on reconnect/visibility/online, exposes degraded state, and advances status only through the guarded RPC');
