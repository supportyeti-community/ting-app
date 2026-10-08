-- TING-11A: canonical multi-tenant ordering foundation.
-- Repository-only migration. Do not apply to production until explicitly approved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  table_number text NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  subtotal numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  client_request_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK (status IN ('submitted','accepted','preparing','ready','completed')),
  CONSTRAINT orders_table_number_clean CHECK (table_number ~ '^[A-Za-z0-9 _-]{1,20}$'),
  CONSTRAINT orders_subtotal_nonnegative CHECK (subtotal >= 0),
  CONSTRAINT orders_total_nonnegative CHECK (total >= 0),
  CONSTRAINT orders_total_matches_subtotal CHECK (total = subtotal),
  CONSTRAINT orders_tenant_client_request_key UNIQUE (tenant_id, client_request_id)
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE RESTRICT,
  item_name_snapshot text NOT NULL,
  unit_price_snapshot numeric(12,2) NOT NULL,
  quantity integer NOT NULL,
  line_total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_items_name_length CHECK (length(trim(item_name_snapshot)) BETWEEN 1 AND 200),
  CONSTRAINT order_items_unit_price_nonnegative CHECK (unit_price_snapshot >= 0),
  CONSTRAINT order_items_quantity_range CHECK (quantity BETWEEN 1 AND 99),
  CONSTRAINT order_items_line_total_nonnegative CHECK (line_total >= 0),
  CONSTRAINT order_items_line_total_matches CHECK (line_total = round(unit_price_snapshot * quantity, 2))
);

CREATE INDEX orders_tenant_status_created_idx
  ON public.orders (tenant_id, status, created_at DESC);
CREATE INDEX order_items_tenant_order_idx
  ON public.order_items (tenant_id, order_id);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.order_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.orders TO authenticated;
GRANT SELECT ON public.order_items TO authenticated;

CREATE POLICY orders_member_read
ON public.orders FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

CREATE POLICY order_items_member_read
ON public.order_items FOR SELECT TO authenticated
USING (
  ting_private.can_manage_tenant(tenant_id)
  AND EXISTS (
    SELECT 1
    FROM public.orders parent_order
    WHERE parent_order.id = order_items.order_id
      AND parent_order.tenant_id = order_items.tenant_id
  )
);

CREATE OR REPLACE FUNCTION ting_private.submit_order(
  p_table_number text,
  p_client_request_id uuid,
  p_items jsonb
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  normalized_table text;
  item_count integer;
  request_row record;
  menu_row public.menu_items%ROWTYPE;
  unit_price numeric(12,2);
  computed_subtotal numeric(12,2) := 0;
  existing_order public.orders%ROWTYPE;
  created_order public.orders%ROWTYPE;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'order submission requires a valid tenant route'
      USING errcode = '23514';
  END IF;

  normalized_table := trim(COALESCE(p_table_number, ''));
  IF normalized_table !~ '^[A-Za-z0-9 _-]{1,20}$' THEN
    RAISE EXCEPTION 'invalid table context' USING errcode = '23514';
  END IF;

  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required' USING errcode = '23514';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array' USING errcode = '23514';
  END IF;

  item_count := jsonb_array_length(p_items);
  IF item_count < 1 OR item_count > 50 THEN
    RAISE EXCEPTION 'order must contain between 1 and 50 line items' USING errcode = '23514';
  END IF;

  SELECT * INTO existing_order
  FROM public.orders
  WHERE tenant_id = routed_tenant_id
    AND client_request_id = p_client_request_id;

  IF FOUND THEN
    RETURN existing_order;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.ting11_order_lines (
    menu_item_id uuid PRIMARY KEY,
    item_name text NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    quantity integer NOT NULL,
    line_total numeric(12,2) NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.ting11_order_lines;

  FOR request_row IN
    SELECT
      x.menu_item_id,
      sum(x.quantity)::integer AS quantity
    FROM (
      SELECT
        CASE
          WHEN item ? 'menu_item_id' AND (item->>'menu_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (item->>'menu_item_id')::uuid
          ELSE NULL
        END AS menu_item_id,
        CASE
          WHEN item ? 'quantity' AND (item->>'quantity') ~ '^[0-9]+$'
          THEN (item->>'quantity')::integer
          ELSE NULL
        END AS quantity
      FROM jsonb_array_elements(p_items) AS item
    ) x
    GROUP BY x.menu_item_id
  LOOP
    IF request_row.menu_item_id IS NULL
       OR request_row.quantity IS NULL
       OR request_row.quantity < 1
       OR request_row.quantity > 99 THEN
      RAISE EXCEPTION 'invalid order item payload' USING errcode = '23514';
    END IF;

    SELECT * INTO menu_row
    FROM public.menu_items
    WHERE id = request_row.menu_item_id
      AND tenant_id = routed_tenant_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'menu item is unavailable for this restaurant' USING errcode = '23514';
    END IF;

    IF COALESCE(menu_row.is_out_of_stock, false) THEN
      RAISE EXCEPTION 'menu item is out of stock' USING errcode = '23514';
    END IF;

    unit_price := round(
      CASE
        WHEN COALESCE(menu_row.is_promo, false) AND menu_row.promo_price IS NOT NULL
          THEN menu_row.promo_price
        ELSE menu_row.price
      END,
      2
    );

    INSERT INTO pg_temp.ting11_order_lines(menu_item_id, item_name, unit_price, quantity, line_total)
    VALUES (
      menu_row.id,
      menu_row.name,
      unit_price,
      request_row.quantity,
      round(unit_price * request_row.quantity, 2)
    );
  END LOOP;

  SELECT COALESCE(round(sum(line_total), 2), 0)
  INTO computed_subtotal
  FROM pg_temp.ting11_order_lines;

  BEGIN
    INSERT INTO public.orders (
      tenant_id,
      table_number,
      status,
      subtotal,
      total,
      client_request_id
    )
    VALUES (
      routed_tenant_id,
      normalized_table,
      'submitted',
      computed_subtotal,
      computed_subtotal,
      p_client_request_id
    )
    RETURNING * INTO created_order;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO created_order
    FROM public.orders
    WHERE tenant_id = routed_tenant_id
      AND client_request_id = p_client_request_id;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    RETURN created_order;
  END;

  INSERT INTO public.order_items (
    tenant_id,
    order_id,
    menu_item_id,
    item_name_snapshot,
    unit_price_snapshot,
    quantity,
    line_total
  )
  SELECT
    routed_tenant_id,
    created_order.id,
    line.menu_item_id,
    line.item_name,
    line.unit_price,
    line.quantity,
    line.line_total
  FROM pg_temp.ting11_order_lines line;

  RETURN created_order;
END;
$function$;

ALTER FUNCTION ting_private.submit_order(text, uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.submit_order(text, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_order(
  p_table_number text,
  p_client_request_id uuid,
  p_items jsonb
)
RETURNS public.orders
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.submit_order(p_table_number, p_client_request_id, p_items);
$function$;

REVOKE ALL ON FUNCTION public.submit_order(text, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_order(text, uuid, jsonb) TO anon, authenticated;
GRANT USAGE ON SCHEMA ting_private TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.submit_order(text, uuid, jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION ting_private.advance_order_status(
  p_order_id uuid,
  p_next_status text
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_order public.orders%ROWTYPE;
  updated_order public.orders%ROWTYPE;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING errcode = '42501';
  END IF;

  SELECT * INTO current_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR NOT ting_private.can_manage_tenant(current_order.tenant_id) THEN
    RAISE EXCEPTION 'order unavailable' USING errcode = '42501';
  END IF;

  IF NOT (
    (current_order.status = 'submitted' AND p_next_status = 'accepted') OR
    (current_order.status = 'accepted' AND p_next_status = 'preparing') OR
    (current_order.status = 'preparing' AND p_next_status = 'ready') OR
    (current_order.status = 'ready' AND p_next_status = 'completed')
  ) THEN
    RAISE EXCEPTION 'invalid order status transition' USING errcode = '23514';
  END IF;

  UPDATE public.orders
  SET
    status = p_next_status,
    accepted_at = CASE WHEN p_next_status = 'accepted' THEN now() ELSE accepted_at END,
    preparing_at = CASE WHEN p_next_status = 'preparing' THEN now() ELSE preparing_at END,
    ready_at = CASE WHEN p_next_status = 'ready' THEN now() ELSE ready_at END,
    completed_at = CASE WHEN p_next_status = 'completed' THEN now() ELSE completed_at END,
    updated_at = now()
  WHERE id = current_order.id
  RETURNING * INTO updated_order;

  RETURN updated_order;
END;
$function$;

ALTER FUNCTION ting_private.advance_order_status(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.advance_order_status(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.advance_order_status(
  p_order_id uuid,
  p_next_status text
)
RETURNS public.orders
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.advance_order_status(p_order_id, p_next_status);
$function$;

REVOKE ALL ON FUNCTION public.advance_order_status(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.advance_order_status(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION ting_private.advance_order_status(uuid, text) TO authenticated;

COMMENT ON TABLE public.orders IS
  'Canonical tenant-owned restaurant orders. Customer submissions are accepted only through submit_order RPC; tenant members may read their tenant orders.';
COMMENT ON TABLE public.order_items IS
  'Immutable historical line-item snapshots for canonical tenant-owned orders.';
COMMENT ON FUNCTION public.submit_order(text, uuid, jsonb) IS
  'Route-bound idempotent order submission. The database resolves tenant, validates menu ownership/stock, and calculates authoritative prices.';
COMMENT ON FUNCTION public.advance_order_status(uuid, text) IS
  'Tenant-member-only controlled order lifecycle transition: submitted -> accepted -> preparing -> ready -> completed.';

NOTIFY pgrst, 'reload schema';
COMMIT;
