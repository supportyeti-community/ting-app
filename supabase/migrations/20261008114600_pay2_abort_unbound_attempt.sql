-- PAY-2: immediately release a pre-processor reservation when processor setup fails.
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

CREATE OR REPLACE FUNCTION public.abort_created_payment_attempt(
  p_attempt_id uuid,
  p_failure_code text DEFAULT NULL,
  p_failure_message text DEFAULT NULL
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.abort_created_payment_attempt(p_attempt_id,p_failure_code,p_failure_message);
$function$;

REVOKE ALL ON FUNCTION public.abort_created_payment_attempt(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abort_created_payment_attempt(uuid,text,text)
  TO service_role;

COMMENT ON FUNCTION public.abort_created_payment_attempt(uuid,text,text) IS
  'Service-role-only immediate release of an unbound created attempt when processor setup fails.';

NOTIFY pgrst, 'reload schema';
COMMIT;
