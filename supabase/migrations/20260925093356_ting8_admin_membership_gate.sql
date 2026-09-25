-- TING-8: explicit admin membership gate for the currently routed tenant.
BEGIN;

CREATE OR REPLACE FUNCTION public.can_manage_current_tenant()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    ting_private.can_manage_tenant(ting_private.request_tenant_id()),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.can_manage_current_tenant()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_current_tenant()
  TO authenticated;

COMMENT ON FUNCTION public.can_manage_current_tenant() IS
  'Returns whether the current authenticated user can manage the tenant resolved from the request route. Exposes only a boolean; membership rows remain private.';

NOTIFY pgrst, 'reload schema';

COMMIT;
