import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../../migrations/20261008074200_ting11_ordering_foundation.sql', import.meta.url),
  'utf8'
);

assert(migration.includes('CREATE TABLE public.orders'), 'orders table missing');
assert(migration.includes('CREATE TABLE public.order_items'), 'order_items table missing');
assert(migration.includes('tenant_id uuid NOT NULL REFERENCES public.tenants(id)'), 'orders/items must carry canonical tenant ownership');
assert(migration.includes('UNIQUE (tenant_id, client_request_id)'), 'tenant-scoped idempotency key missing');
assert(migration.includes("CHECK (status IN ('submitted','accepted','preparing','ready','completed'))"), 'status domain must be constrained');

assert(migration.includes('ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;'), 'orders RLS must be enabled');
assert(migration.includes('ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;'), 'order_items RLS must be enabled');
assert(migration.includes('REVOKE ALL ON public.orders FROM PUBLIC, anon, authenticated;'), 'orders grants must start fail-closed');
assert(migration.includes('REVOKE ALL ON public.order_items FROM PUBLIC, anon, authenticated;'), 'order_items grants must start fail-closed');
assert(!migration.includes('GRANT INSERT ON public.orders TO anon'), 'anon must not insert orders directly');
assert(!migration.includes('GRANT INSERT ON public.order_items TO anon'), 'anon must not insert order items directly');

assert(migration.includes('CREATE POLICY orders_member_read'), 'orders member read policy missing');
assert(migration.includes('CREATE POLICY order_items_member_read'), 'order_items member read policy missing');
assert(migration.includes('ting_private.can_manage_tenant(tenant_id)'), 'member reads must use canonical membership authorization');

assert(migration.includes('CREATE OR REPLACE FUNCTION ting_private.submit_order('), 'private submit implementation missing');
assert(migration.includes('SECURITY DEFINER\nSET search_path = \'\''), 'privileged ordering functions must pin an empty search_path');
assert(migration.includes('routed_tenant_id := ting_private.request_tenant_id();'), 'submission must derive tenant from the route');
assert(migration.includes('AND tenant_id = routed_tenant_id'), 'menu item validation must be tenant-scoped');
assert(migration.includes('COALESCE(menu_row.is_out_of_stock, false)'), 'submission must reject out-of-stock menu items');
assert(migration.includes('menu_row.promo_price'), 'database must derive active authoritative promo pricing');
assert(migration.includes('item_name_snapshot'), 'order items must snapshot item names');
assert(migration.includes('unit_price_snapshot'), 'order items must snapshot authoritative prices');

assert(migration.includes('CREATE OR REPLACE FUNCTION public.submit_order('), 'public submit RPC wrapper missing');
assert(migration.includes('LANGUAGE sql\nVOLATILE\nSECURITY INVOKER'), 'public RPC wrappers must remain security-invoker');
assert(migration.includes('GRANT EXECUTE ON FUNCTION public.submit_order(text, uuid, jsonb) TO anon, authenticated;'), 'routed customers must be able to call submit_order');

assert(migration.includes('CREATE OR REPLACE FUNCTION ting_private.advance_order_status('), 'private state transition implementation missing');
assert(migration.includes("current_order.status = 'submitted' AND p_next_status = 'accepted'"), 'submitted -> accepted transition missing');
assert(migration.includes("current_order.status = 'accepted' AND p_next_status = 'preparing'"), 'accepted -> preparing transition missing');
assert(migration.includes("current_order.status = 'preparing' AND p_next_status = 'ready'"), 'preparing -> ready transition missing');
assert(migration.includes("current_order.status = 'ready' AND p_next_status = 'completed'"), 'ready -> completed transition missing');
assert(migration.includes('NOT ting_private.can_manage_tenant(current_order.tenant_id)'), 'status transitions must require tenant membership');
assert(migration.includes('GRANT EXECUTE ON FUNCTION public.advance_order_status(uuid, text) TO authenticated;'), 'only authenticated clients may call status transition RPC');

console.log('PASS: TING-11A ordering foundation preserves route-derived ownership, authoritative pricing, idempotency, RLS, and controlled status transitions');
