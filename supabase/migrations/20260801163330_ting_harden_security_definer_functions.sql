-- TinG Migration 002 v4
BEGIN;
DO $preflight$
DECLARE
  admin_fn oid := to_regprocedure('public.is_admin()');
  rls_fn oid := to_regprocedure('public.rls_auto_enable()');
  authenticated_oid oid := (SELECT oid FROM pg_roles WHERE rolname='authenticated');
  dependency_count integer;
  wrong_role_count integer;
BEGIN
  IF admin_fn IS NULL OR rls_fn IS NULL THEN RAISE EXCEPTION 'Preflight failed: expected public functions are missing'; END IF;
  IF to_regprocedure('ting_private.rls_auto_enable()') IS NOT NULL THEN RAISE EXCEPTION 'Preflight failed: private rls_auto_enable() already exists'; END IF;
  IF authenticated_oid IS NULL THEN RAISE EXCEPTION 'Preflight failed: authenticated role is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='ting_private' AND r.rolname='postgres') THEN RAISE EXCEPTION 'Preflight failed: ting_private is missing or not postgres-owned'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=admin_fn AND r.rolname='postgres' AND p.prosecdef AND pg_get_function_result(p.oid)='boolean') THEN RAISE EXCEPTION 'Preflight failed: is_admin() signature, owner, or mode drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=rls_fn AND r.rolname='postgres' AND p.prosecdef AND pg_get_function_result(p.oid)='event_trigger') THEN RAISE EXCEPTION 'Preflight failed: rls_auto_enable() signature, owner, or mode drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.admin_users'::regclass AND c.relrowsecurity) OR NOT has_table_privilege('authenticated','public.admin_users','SELECT') THEN RAISE EXCEPTION 'Preflight failed: admin_users RLS or SELECT grant drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_users) OR EXISTS (SELECT 1 FROM public.admin_users WHERE user_id='00000000-0000-0000-0000-000000000000'::uuid) THEN RAISE EXCEPTION 'Preflight failed: deterministic admin identity test boundary drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.service_tickets'::regclass AND c.relrowsecurity) OR NOT has_table_privilege('authenticated','public.service_tickets','SELECT') OR NOT EXISTS (SELECT 1 FROM public.service_tickets) THEN RAISE EXCEPTION 'Preflight failed: representative service_tickets RLS test boundary drifted'; END IF;
  SELECT count(DISTINCT p.oid), count(DISTINCT p.oid) FILTER (WHERE p.polroles <> ARRAY[authenticated_oid]::oid[]) INTO dependency_count, wrong_role_count FROM pg_depend d JOIN pg_policy p ON d.classid='pg_policy'::regclass AND d.objid=p.oid WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=admin_fn;
  IF dependency_count <> 20 OR wrong_role_count <> 0 THEN RAISE EXCEPTION 'Preflight failed: is_admin() policy dependency boundary drifted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtname='ensure_rls' AND e.evtevent='ddl_command_end' AND e.evtenabled='O' AND e.evtfoid=rls_fn AND e.evttags=ARRAY['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]) THEN RAISE EXCEPTION 'Preflight failed: ensure_rls definition drifted'; END IF;
END
$preflight$;
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $is_admin$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM public.admin_users WHERE public.admin_users.user_id=auth.uid());
END
$is_admin$;
ALTER FUNCTION public.is_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
DROP EVENT TRIGGER ensure_rls;
DROP FUNCTION public.rls_auto_enable();
CREATE FUNCTION ting_private.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $rls_auto_enable$
DECLARE cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') AND object_type IN ('table','partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security',cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %',cmd.object_identity;
      EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'rls_auto_enable: failed to enable RLS on %',cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (schema: %)',cmd.object_identity,cmd.schema_name;
    END IF;
  END LOOP;
END
$rls_auto_enable$;
ALTER FUNCTION ting_private.rls_auto_enable() OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION ting_private.rls_auto_enable();
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET LOCAL ROLE anon;
DO $anon_test$ BEGIN IF public.is_admin() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Verification failed: anon is_admin() test'; END IF; END $anon_test$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',(SELECT user_id::text FROM public.admin_users ORDER BY user_id LIMIT 1),true);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',(SELECT user_id FROM public.admin_users ORDER BY user_id LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $admin_test$ BEGIN IF public.is_admin() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Verification failed: authenticated admin is_admin() test'; END IF; IF NOT EXISTS (SELECT 1 FROM public.service_tickets) THEN RAISE EXCEPTION 'Verification failed: representative admin RLS policy denied all rows'; END IF; END $admin_test$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
DO $non_admin_test$ BEGIN IF public.is_admin() IS DISTINCT FROM false THEN RAISE EXCEPTION 'Verification failed: authenticated non-admin is_admin() test'; END IF; IF EXISTS (SELECT 1 FROM public.service_tickets) THEN RAISE EXCEPTION 'Verification failed: representative non-admin RLS policy exposed rows'; END IF; END $non_admin_test$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub',(SELECT user_id::text FROM public.admin_users ORDER BY user_id LIMIT 1),true);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',(SELECT user_id FROM public.admin_users ORDER BY user_id LIMIT 1),'role','service_role')::text,true);
SET LOCAL ROLE service_role;
DO $service_role_test$ BEGIN IF public.is_admin() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Verification failed: service_role is_admin() test'; END IF; END $service_role_test$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','',true);
CREATE TABLE public.__ting_m002_rls_probe (id bigint);
DO $trigger_test$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.__ting_m002_rls_probe'::regclass AND c.relrowsecurity) THEN RAISE EXCEPTION 'Verification failed: ensure_rls did not enable RLS'; END IF; END $trigger_test$;
DROP TABLE public.__ting_m002_rls_probe;
DO $final_checks$
DECLARE admin_fn oid := to_regprocedure('public.is_admin()'); rls_fn oid := to_regprocedure('ting_private.rls_auto_enable()');
BEGIN
  IF admin_fn IS NULL OR rls_fn IS NULL OR to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN RAISE EXCEPTION 'Final check failed: function placement'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=admin_fn AND prosecdef) THEN RAISE EXCEPTION 'Final check failed: is_admin remains definer'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=admin_fn AND r.rolname='postgres' AND l.lanname='plpgsql' AND NOT p.prosecdef AND p.provolatile='v' AND pg_get_function_result(p.oid)='boolean' AND p.proconfig=ARRAY['search_path=""']::text[]) THEN RAISE EXCEPTION 'Final check failed: is_admin security configuration'; END IF;
  IF NOT has_function_privilege('anon',admin_fn,'EXECUTE') OR NOT has_function_privilege('authenticated',admin_fn,'EXECUTE') OR NOT has_function_privilege('service_role',admin_fn,'EXECUTE') THEN RAISE EXCEPTION 'Final check failed: is_admin grants'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid IN (admin_fn,rls_fn) AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Final check failed: PUBLIC execute remains'; END IF;
  IF has_function_privilege('anon',rls_fn,'EXECUTE') OR has_function_privilege('authenticated',rls_fn,'EXECUTE') OR has_function_privilege('service_role',rls_fn,'EXECUTE') THEN RAISE EXCEPTION 'Final check failed: internal function executable by client/service role'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=rls_fn AND r.rolname='postgres' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]) THEN RAISE EXCEPTION 'Final check failed: internal function security state'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtname='ensure_rls' AND e.evtenabled='O' AND e.evtfoid=rls_fn AND e.evttags=ARRAY['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]) THEN RAISE EXCEPTION 'Final check failed: event trigger binding'; END IF;
  IF to_regclass('public.__ting_m002_rls_probe') IS NOT NULL THEN RAISE EXCEPTION 'Final check failed: probe table remains'; END IF;
END
$final_checks$;
COMMIT;