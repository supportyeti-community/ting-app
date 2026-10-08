-- PAY-2: service-role-only public wrappers must cross into ting_private safely.
-- SECURITY DEFINER is intentional here; anon/authenticated have no EXECUTE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.bind_payment_provider(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT ting_private.bind_payment_provider(p_attempt_id,p_provider,p_provider_payment_id);
$function$;
ALTER FUNCTION public.bind_payment_provider(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bind_payment_provider(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_payment_provider(uuid,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.release_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_terminal_status text,
  p_failure_code text DEFAULT NULL,
  p_failure_message text DEFAULT NULL
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT ting_private.release_payment_attempt(
    p_attempt_id,p_provider,p_provider_payment_id,p_terminal_status,p_failure_code,p_failure_message
  );
$function$;
ALTER FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_payment_attempt_trusted(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_confirmed_amount numeric,
  p_currency text
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT ting_private.confirm_payment_attempt(
    p_attempt_id,p_provider,p_provider_payment_id,p_confirmed_amount,p_currency
  );
$function$;
ALTER FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.abort_created_payment_attempt(
  p_attempt_id uuid,
  p_failure_code text DEFAULT NULL,
  p_failure_message text DEFAULT NULL
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT ting_private.abort_created_payment_attempt(p_attempt_id,p_failure_code,p_failure_message);
$function$;
ALTER FUNCTION public.abort_created_payment_attempt(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.abort_created_payment_attempt(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abort_created_payment_attempt(uuid,text,text)
  TO service_role;

COMMENT ON FUNCTION public.bind_payment_provider(uuid,text,text) IS
  'Service-role-only SECURITY DEFINER wrapper for exact processor binding; no anon/authenticated execute grant.';
COMMENT ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text) IS
  'Service-role-only SECURITY DEFINER wrapper for trusted processor terminal release; no anon/authenticated execute grant.';
COMMENT ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text) IS
  'Service-role-only SECURITY DEFINER wrapper for trusted payment reconciliation; no anon/authenticated execute grant.';
COMMENT ON FUNCTION public.abort_created_payment_attempt(uuid,text,text) IS
  'Service-role-only SECURITY DEFINER wrapper for aborting an unbound processor setup failure; no anon/authenticated execute grant.';

NOTIFY pgrst, 'reload schema';
COMMIT;
