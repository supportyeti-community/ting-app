-- TING-2 routing preparation. The public SELECT path stays available for
-- deployed clients until both bootloaders send x-client-slug in production.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.restaurant_clients'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_users'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies WHERE schemaname = 'public'
         AND tablename = 'restaurant_clients'
         AND policyname = 'Public can read client routing config'
     ) THEN
    RAISE EXCEPTION 'TING-2 routing preparation: registry policy or RLS drift';
  END IF;
END $$;

-- The browser only reads routing configuration. Provisioning and changing a
-- platform route remain trusted operator tasks, not global admin-user rights.
REVOKE ALL ON TABLE public.restaurant_clients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.restaurant_clients TO anon, authenticated;
DROP POLICY "Admins can insert client routing config" ON public.restaurant_clients;
DROP POLICY "Admins can update client routing config" ON public.restaurant_clients;
DROP POLICY "Admins can delete client routing config" ON public.restaurant_clients;

-- The existing own-row read is still used by the legacy menu-pictures storage
-- policies through is_admin(). Do not retire the allowlist in this slice.
REVOKE ALL ON TABLE public.admin_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_users TO authenticated;

COMMENT ON TABLE public.restaurant_clients IS
  'Platform routing registry. Client SELECT remains global during bootstrap compatibility; operator-managed writes only. Restrict SELECT after both deployed bootloaders send x-client-slug.';
COMMENT ON TABLE public.admin_users IS
  'Legacy platform allowlist, retained for menu-pictures storage policies. Own-row authenticated read only; trusted operator writes.';
NOTIFY pgrst, 'reload schema';
COMMIT;
