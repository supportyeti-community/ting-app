-- PAY-2: immediately release a pre-processor reservation when processor setup fails.
-- Also harden service-role-only public wrappers so they can cross into ting_private.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION ting_private.abort_created_payment_attempt(
  p_attempt_id uuid,
  p_failure_code text DEFAULT NULL,
  p_failure_message text DEFAULT NULL
)
RETURNS public.payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  updated_attempt public.payment_attempts%ROWTYPE;
BEGIN
  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501';
  END IF;

  IF attempt.status = 'failed' AND attempt.provider_payment_id IS NULL THEN
    RETURN attempt;
  END IF;

  IF attempt.status <> 'created' OR attempt.provider_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'only an unbound created payment attempt can be aborted' USING errcode='23514';
  END IF;

  UPDATE public.payment_attempts
  SET status = 'failed',
      failure_code = NULLIF(left(COALESCE(p_failure_code,''),120),''),
      failure_message = NULLIF(left(COALESCE(p_failure_message,''),500),''),
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO updated_attempt;

  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.abort_created_payment_attempt(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.abort_created_payment_attempt(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.abort_created_payment_attempt(uuid,text,text)
  TO service_role;

-- These public wrappers are intentionally SECURITY DEFINER but service-role-only.
-- Unlike the customer balance RPC, anon/authenticated have no EXECUTE grants.
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
