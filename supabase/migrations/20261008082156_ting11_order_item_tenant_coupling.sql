-- TING-11A hardening: require every order item to belong to the same tenant as its parent order.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.orders
  ADD CONSTRAINT orders_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.order_items
  DROP CONSTRAINT order_items_order_id_fkey;

ALTER TABLE public.order_items
  ADD CONSTRAINT order_items_order_tenant_fkey
  FOREIGN KEY (tenant_id, order_id)
  REFERENCES public.orders (tenant_id, id)
  ON DELETE CASCADE;

COMMENT ON CONSTRAINT order_items_order_tenant_fkey ON public.order_items IS
  'Prevents an order item from carrying a tenant_id different from its parent order tenant.';

COMMIT;
