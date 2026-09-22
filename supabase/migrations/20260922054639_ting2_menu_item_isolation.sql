-- TING-2 second release: tenant-isolate public menu items and member writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.menu_items IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.menu_items item
    LEFT JOIN public.tenants tenant ON tenant.id = item.tenant_id
    WHERE item.tenant_id IS NULL
       OR tenant.id IS NULL
       OR tenant.client_slug IS DISTINCT FROM item.client_slug
  ) THEN
    RAISE EXCEPTION 'TING-2 menu items require explicit, matching tenant ownership';
  END IF;
END $$;

ALTER TABLE public.menu_items ALTER COLUMN tenant_id SET NOT NULL;

CREATE FUNCTION ting_private.prevent_menu_item_reassignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_slug IS DISTINCT FROM OLD.client_slug THEN
    RAISE EXCEPTION 'Menu item tenant ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ting_private.prevent_menu_item_reassignment()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER menu_items_tenant_immutable BEFORE UPDATE ON public.menu_items
FOR EACH ROW EXECUTE FUNCTION ting_private.prevent_menu_item_reassignment();

DROP POLICY "Admins can delete menu items" ON public.menu_items;
DROP POLICY "Admins can insert menu items" ON public.menu_items;
DROP POLICY "Admins can update menu items" ON public.menu_items;
DROP POLICY "Public can read menu items" ON public.menu_items;

REVOKE ALL ON public.menu_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.menu_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.menu_items TO authenticated;

CREATE POLICY menu_items_public_route ON public.menu_items FOR SELECT TO anon, authenticated
USING (tenant_id = (SELECT ting_private.request_tenant_id()));
CREATE POLICY menu_items_member_read ON public.menu_items FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_items_member_insert ON public.menu_items FOR INSERT TO authenticated
WITH CHECK (
  ting_private.can_manage_tenant(tenant_id)
  AND price >= 0
  AND (promo_price IS NULL OR promo_price >= 0)
);
CREATE POLICY menu_items_member_update ON public.menu_items FOR UPDATE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id))
WITH CHECK (
  ting_private.can_manage_tenant(tenant_id)
  AND price >= 0
  AND (promo_price IS NULL OR promo_price >= 0)
);
CREATE POLICY menu_items_member_delete ON public.menu_items FOR DELETE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

-- DELETE events cannot be filtered by RLS. Both customer and admin pages poll
-- tenant-scoped REST reads after this release.
ALTER PUBLICATION supabase_realtime DROP TABLE public.menu_items;
NOTIFY pgrst, 'reload schema';
COMMIT;
