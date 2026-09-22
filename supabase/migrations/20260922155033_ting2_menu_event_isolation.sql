-- TING-2 third release: route-bound, tenant-owned, append-only menu analytics.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.menu_events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.tenants, public.menu_items IN SHARE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.menu_events event
    LEFT JOIN public.tenants tenant ON tenant.id = event.tenant_id
    LEFT JOIN public.menu_items item ON item.id = event.item_id
    WHERE event.tenant_id IS NULL
       OR tenant.id IS NULL
       OR tenant.client_slug IS DISTINCT FROM event.client_slug
       OR (event.item_id IS NOT NULL AND item.tenant_id IS DISTINCT FROM event.tenant_id)
  ) THEN
    RAISE EXCEPTION 'TING-2 menu events require explicit, matching tenant and item ownership';
  END IF;
END $$;

ALTER TABLE public.menu_events ALTER COLUMN tenant_id SET NOT NULL;

DROP POLICY "Admins can delete menu analytics" ON public.menu_events;
DROP POLICY "Admins can read menu analytics" ON public.menu_events;
DROP POLICY "Public can insert menu analytics" ON public.menu_events;

REVOKE ALL ON public.menu_events FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.menu_events TO anon;
GRANT SELECT, INSERT, DELETE ON public.menu_events TO authenticated;

-- The existing BEFORE INSERT trigger resolves client_slug to tenant_id and
-- rejects an explicitly mismatched pair. The request route must resolve to that
-- same tenant, and an optional item reference must belong to it as well.
CREATE POLICY menu_events_routed_insert ON public.menu_events FOR INSERT TO anon, authenticated
WITH CHECK (
  tenant_id = (SELECT ting_private.request_tenant_id())
  AND (
    item_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.menu_items item
      WHERE item.id = menu_events.item_id
        AND item.tenant_id = menu_events.tenant_id
    )
  )
);
CREATE POLICY menu_events_member_read ON public.menu_events FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_events_member_delete ON public.menu_events FOR DELETE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

COMMENT ON TABLE public.menu_events IS
  'Append-only client telemetry: routed inserts; tenant member reads and deletes; no client updates.';
NOTIFY pgrst, 'reload schema';
COMMIT;
