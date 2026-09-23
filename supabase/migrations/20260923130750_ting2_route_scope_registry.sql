-- Route-scope the public platform registry. A slug is public routing context,
-- never proof of membership or authorization for tenant-owned data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.restaurant_clients'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
           AND tablename = 'restaurant_clients') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
           AND tablename = 'restaurant_clients'
           AND policyname = 'Public can read client routing config'
           AND qual = 'true')
     OR (SELECT count(*) FROM public.restaurant_clients WHERE client_slug = 'the-bistro') <> 1
  THEN RAISE EXCEPTION 'TING-2 routing registry preflight drift'; END IF;
END $$;

-- The only headerless compatibility route is the existing internal demo.
-- An old cached page can still bootstrap, but cannot enumerate later tenants.
-- Unknown, malformed and explicitly empty headers fail closed.
CREATE FUNCTION ting_private.routing_client_slug() RETURNS text
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE headers jsonb; slug text;
BEGIN
  BEGIN
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
  END;
  IF headers IS NULL OR NOT headers ? 'x-client-slug' THEN RETURN 'the-bistro'; END IF;
  slug := headers ->> 'x-client-slug';
  IF slug IS NULL OR slug !~ '^[A-Za-z0-9_-]{1,80}$' THEN RETURN NULL; END IF;
  RETURN slug;
END $$;
REVOKE ALL ON FUNCTION ting_private.routing_client_slug() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.routing_client_slug() TO anon, authenticated;

DROP POLICY "Public can read client routing config" ON public.restaurant_clients;
CREATE POLICY routing_registry_public_route ON public.restaurant_clients
FOR SELECT TO anon, authenticated
USING (client_slug = (SELECT ting_private.routing_client_slug()));

COMMENT ON TABLE public.restaurant_clients IS
  'Public platform routing registry: exact header-scoped SELECT; headerless legacy fallback exposes only the-bistro until cached pages are retired. Operator-managed writes only. A public slug is not authorization.';
NOTIFY pgrst, 'reload schema';
COMMIT;
