-- TING-2 first release: settings and table links only. Review before rollout.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.restaurant_settings, public.table_configurations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.restaurant_settings WHERE tenant_id IS NULL)
     OR EXISTS (SELECT 1 FROM public.table_configurations WHERE tenant_id IS NULL) THEN
    RAISE EXCEPTION 'TING-2 requires explicit ownership mapping before enforcement';
  END IF;
END $$;
ALTER TABLE public.restaurant_settings ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.restaurant_settings ADD CONSTRAINT restaurant_settings_tenant_key UNIQUE (tenant_id);
ALTER TABLE public.table_configurations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE public.table_configurations DROP CONSTRAINT table_configurations_pkey;
ALTER TABLE public.table_configurations ADD PRIMARY KEY (tenant_id, source_table, target_table);

-- Public routing lookup, deliberately available without authentication. A slug is
-- not authorization. This reads only a UUID; all writes require auth membership.
CREATE FUNCTION ting_private.request_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE headers jsonb; slug text;
BEGIN
  BEGIN
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
  END;
  slug := headers ->> 'x-client-slug';
  IF slug IS NULL OR slug !~ '^[A-Za-z0-9_-]{1,80}$' THEN RETURN NULL; END IF;
  RETURN (SELECT id FROM public.tenants WHERE client_slug = slug);
END $$;
CREATE FUNCTION ting_private.can_manage_tenant(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tenant_memberships m
    WHERE m.user_id = auth.uid() AND m.tenant_id = target
      AND m.role IN ('owner', 'admin')
  );
$$;
REVOKE ALL ON FUNCTION ting_private.request_tenant_id(), ting_private.can_manage_tenant(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA ting_private TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.request_tenant_id() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.can_manage_tenant(uuid) TO authenticated;
-- Invoker wrapper exposes only the public routing UUID through PostgREST.
CREATE FUNCTION public.request_tenant_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT ting_private.request_tenant_id();
$$;
REVOKE ALL ON FUNCTION public.request_tenant_id() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_tenant_id() TO anon, authenticated;

CREATE FUNCTION ting_private.prevent_tenant_reassignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'Tenant ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ting_private.prevent_tenant_reassignment() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER settings_tenant_immutable BEFORE UPDATE ON public.restaurant_settings
FOR EACH ROW EXECUTE FUNCTION ting_private.prevent_tenant_reassignment();
CREATE TRIGGER table_links_tenant_immutable BEFORE UPDATE ON public.table_configurations
FOR EACH ROW EXECUTE FUNCTION ting_private.prevent_tenant_reassignment();

DROP POLICY "Admins can delete restaurant settings" ON public.restaurant_settings;
DROP POLICY "Admins can insert restaurant settings" ON public.restaurant_settings;
DROP POLICY "Admins can update restaurant settings" ON public.restaurant_settings;
DROP POLICY "Public can read restaurant settings" ON public.restaurant_settings;
DROP POLICY "Admins can delete table configurations" ON public.table_configurations;
DROP POLICY "Admins can insert table configurations" ON public.table_configurations;
DROP POLICY "Admins can update table configurations" ON public.table_configurations;
DROP POLICY "Public can read table configurations" ON public.table_configurations;

REVOKE ALL ON public.restaurant_settings, public.table_configurations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.restaurant_settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.restaurant_settings, public.table_configurations TO authenticated;
CREATE POLICY settings_public_route ON public.restaurant_settings FOR SELECT TO anon, authenticated
USING (tenant_id = (SELECT ting_private.request_tenant_id()));
CREATE POLICY settings_member_read ON public.restaurant_settings FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY settings_member_insert ON public.restaurant_settings FOR INSERT TO authenticated
WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY settings_member_update ON public.restaurant_settings FOR UPDATE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id)) WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY settings_member_delete ON public.restaurant_settings FOR DELETE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY table_links_member_read ON public.table_configurations FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY table_links_member_insert ON public.table_configurations FOR INSERT TO authenticated
WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY table_links_member_update ON public.table_configurations FOR UPDATE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id)) WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY table_links_member_delete ON public.table_configurations FOR DELETE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

-- Postgres Changes DELETE cannot be RLS-filtered. Do not publish these tables.
-- Admin table links use scoped REST polling; no customer subscription uses them.
ALTER PUBLICATION supabase_realtime DROP TABLE public.restaurant_settings, public.table_configurations;
NOTIFY pgrst, 'reload schema';
COMMIT;
