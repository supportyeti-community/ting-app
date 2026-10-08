-- PAY-2: processor-safe payment state boundary for Stripe sandbox integration.
-- Repository-only until explicitly approved for production apply.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A processor-bound pending attempt must continue reserving balance until a
-- trusted terminal event releases it. Only pre-processor created attempts use
-- reservation_expires_at as an automatic balance-release boundary.
CREATE OR REPLACE FUNCTION ting_private.payment_balance(
  p_order_id uuid,
  p_tenant_id uuid,
  p_lock boolean DEFAULT false
)
RETURNS TABLE(
  order_total numeric(12,2),
  amount_paid numeric(12,2),
  amount_reserved numeric(12,2),
  amount_due numeric(12,2),
  amount_available numeric(12,2),
  payment_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_order public.orders%ROWTYPE;
  paid numeric(12,2);
  reserved numeric(12,2);
BEGIN
  IF p_lock THEN
    SELECT * INTO current_order
    FROM public.orders
    WHERE id = p_order_id AND tenant_id = p_tenant_id
    FOR UPDATE;
  ELSE
    SELECT * INTO current_order
    FROM public.orders
    WHERE id = p_order_id AND tenant_id = p_tenant_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order unavailable' USING errcode = '42501';
  END IF;

  SELECT COALESCE(round(sum(a.amount),2),0)
  INTO paid
  FROM public.payment_allocations a
  WHERE a.tenant_id = p_tenant_id
    AND a.order_id = p_order_id;

  SELECT COALESCE(round(sum(a.requested_amount),2),0)
  INTO reserved
  FROM public.payment_attempts a
  WHERE a.tenant_id = p_tenant_id
    AND a.order_id = p_order_id
    AND (
      a.status = 'pending'
      OR (a.status = 'created' AND a.reservation_expires_at > now())
    );

  order_total := current_order.total;
  amount_paid := paid;
  amount_reserved := reserved;
  amount_due := greatest(round(current_order.total - paid,2),0);
  amount_available := greatest(round(current_order.total - paid - reserved,2),0);
  payment_status := CASE
    WHEN paid <= 0 THEN 'unpaid'
    WHEN paid < current_order.total THEN 'partially_paid'
    ELSE 'paid'
  END;
  RETURN NEXT;
END;
$function$;

ALTER FUNCTION ting_private.payment_balance(uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.payment_balance(uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.payment_balance(uuid,uuid,boolean)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION ting_private.expire_payment_reservations(
  p_tenant_id uuid,
  p_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  affected integer;
BEGIN
  UPDATE public.payment_attempts
  SET status = 'expired', updated_at = now(), cancelled_at = now()
  WHERE tenant_id = p_tenant_id
    AND order_id = p_order_id
    AND status = 'created'
    AND provider_payment_id IS NULL
    AND reservation_expires_at <= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

ALTER FUNCTION ting_private.expire_payment_reservations(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.expire_payment_reservations(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION ting_private.bind_payment_provider(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text
)
RETURNS public.payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  normalized_provider text;
  updated_attempt public.payment_attempts%ROWTYPE;
BEGIN
  normalized_provider := lower(trim(COALESCE(p_provider,'')));
  IF normalized_provider !~ '^[a-z0-9_-]{1,40}$'
     OR NULLIF(trim(COALESCE(p_provider_payment_id,'')),'') IS NULL THEN
    RAISE EXCEPTION 'invalid provider binding' USING errcode='23514';
  END IF;

  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501';
  END IF;

  IF attempt.status = 'pending' THEN
    IF attempt.provider = normalized_provider
       AND attempt.provider_payment_id = p_provider_payment_id THEN
      RETURN attempt;
    END IF;
    RAISE EXCEPTION 'payment provider binding mismatch' USING errcode='23514';
  END IF;

  IF attempt.status <> 'created' THEN
    RAISE EXCEPTION 'payment attempt is not bindable' USING errcode='23514';
  END IF;

  IF attempt.reservation_expires_at <= now() THEN
    RAISE EXCEPTION 'payment attempt reservation expired before provider binding' USING errcode='23514';
  END IF;

  UPDATE public.payment_attempts
  SET provider = normalized_provider,
      provider_payment_id = p_provider_payment_id,
      status = 'pending',
      -- Cleanup threshold only. Pending remains reserved even after this time
      -- until the processor is cancelled/terminal and a trusted release occurs.
      reservation_expires_at = now() + interval '30 minutes',
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO updated_attempt;

  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.bind_payment_provider(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.bind_payment_provider(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.bind_payment_provider(uuid,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.bind_payment_provider(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.bind_payment_provider(p_attempt_id,p_provider,p_provider_payment_id);
$function$;

REVOKE ALL ON FUNCTION public.bind_payment_provider(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_payment_provider(uuid,text,text)
  TO service_role;

CREATE OR REPLACE FUNCTION ting_private.release_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_terminal_status text,
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
  normalized_provider text;
  normalized_status text;
  updated_attempt public.payment_attempts%ROWTYPE;
BEGIN
  normalized_provider := lower(trim(COALESCE(p_provider,'')));
  normalized_status := lower(trim(COALESCE(p_terminal_status,'')));

  IF normalized_status NOT IN ('failed','cancelled','expired') THEN
    RAISE EXCEPTION 'invalid releasing terminal status' USING errcode='23514';
  END IF;

  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501';
  END IF;

  IF attempt.provider <> normalized_provider
     OR attempt.provider_payment_id IS DISTINCT FROM p_provider_payment_id THEN
    RAISE EXCEPTION 'payment provider reference mismatch' USING errcode='23514';
  END IF;

  -- Stripe can emit payment_failed followed by canceled after the server
  -- cancels the failed PaymentIntent. Any already-released terminal state is a
  -- harmless replay as long as the canonical provider reference still matches.
  IF attempt.status IN ('failed','cancelled','expired') THEN
    RETURN attempt;
  END IF;

  IF attempt.status = 'succeeded' THEN
    RAISE EXCEPTION 'succeeded payment cannot be released' USING errcode='23514';
  END IF;

  IF attempt.status <> 'pending' THEN
    RAISE EXCEPTION 'payment attempt is not releasable' USING errcode='23514';
  END IF;

  UPDATE public.payment_attempts
  SET status = normalized_status,
      failure_code = NULLIF(left(COALESCE(p_failure_code,''),120),''),
      failure_message = NULLIF(left(COALESCE(p_failure_message,''),500),''),
      cancelled_at = CASE WHEN normalized_status IN ('cancelled','expired') THEN now() ELSE cancelled_at END,
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO updated_attempt;

  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text)
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
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.release_payment_attempt(
    p_attempt_id,p_provider,p_provider_payment_id,p_terminal_status,p_failure_code,p_failure_message
  );
$function$;

REVOKE ALL ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text)
  TO service_role;

-- Harden the existing trusted confirmation primitive so a processor-bound
-- pending attempt cannot have its provider reference silently overwritten.
CREATE OR REPLACE FUNCTION ting_private.confirm_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_confirmed_amount numeric,
  p_currency text
)
RETURNS public.payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  attempt public.payment_attempts%ROWTYPE;
  updated_attempt public.payment_attempts%ROWTYPE;
  normalized_amount numeric(12,2);
  normalized_provider text;
  paid numeric(12,2);
  order_total numeric(12,2);
BEGIN
  normalized_amount := round(p_confirmed_amount,2);
  normalized_provider := lower(trim(COALESCE(p_provider,'')));

  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501'; END IF;

  IF attempt.status = 'succeeded' THEN
    IF attempt.provider = normalized_provider
       AND attempt.provider_payment_id = p_provider_payment_id
       AND attempt.confirmed_amount = normalized_amount
       AND attempt.currency = upper(p_currency) THEN
      RETURN attempt;
    END IF;
    RAISE EXCEPTION 'payment confirmation mismatch' USING errcode='23514';
  END IF;

  IF attempt.status NOT IN ('created','pending') THEN
    RAISE EXCEPTION 'payment attempt is not confirmable' USING errcode='23514';
  END IF;

  IF attempt.provider_payment_id IS NOT NULL
     AND (attempt.provider <> normalized_provider
          OR attempt.provider_payment_id <> p_provider_payment_id) THEN
    RAISE EXCEPTION 'payment provider reference mismatch' USING errcode='23514';
  END IF;

  IF normalized_amount IS NULL OR normalized_amount <= 0 OR normalized_amount <> attempt.requested_amount THEN
    RAISE EXCEPTION 'confirmed amount mismatch' USING errcode='23514';
  END IF;
  IF upper(COALESCE(p_currency,'')) <> attempt.currency THEN
    RAISE EXCEPTION 'currency mismatch' USING errcode='23514';
  END IF;

  SELECT total INTO order_total
  FROM public.orders
  WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id
  FOR UPDATE;

  SELECT COALESCE(round(sum(amount),2),0) INTO paid
  FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;

  IF paid + normalized_amount > order_total THEN
    RAISE EXCEPTION 'payment would exceed order total' USING errcode='23514';
  END IF;

  UPDATE public.payment_attempts
  SET provider = normalized_provider,
      provider_payment_id = p_provider_payment_id,
      confirmed_amount = normalized_amount,
      status = 'succeeded',
      confirmed_at = now(),
      updated_at = now()
  WHERE id = attempt.id
  RETURNING * INTO updated_attempt;

  INSERT INTO public.payment_allocations(tenant_id,order_id,payment_attempt_id,amount,currency)
  VALUES (attempt.tenant_id,attempt.order_id,attempt.id,normalized_amount,attempt.currency)
  ON CONFLICT (payment_attempt_id) DO NOTHING;

  SELECT COALESCE(round(sum(amount),2),0) INTO paid
  FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;

  UPDATE public.orders
  SET payment_status = CASE
        WHEN paid <= 0 THEN 'unpaid'
        WHEN paid < total THEN 'partially_paid'
        ELSE 'paid'
      END,
      updated_at = now()
  WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id;

  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text)
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
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.confirm_payment_attempt(
    p_attempt_id,p_provider,p_provider_payment_id,p_confirmed_amount,p_currency
  );
$function$;

REVOKE ALL ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text)
  TO service_role;

COMMENT ON FUNCTION public.bind_payment_provider(uuid,text,text) IS
  'Service-role-only binding of one processor payment reference to one canonical TinG payment attempt.';
COMMENT ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text) IS
  'Service-role-only release of a processor-bound pending attempt after a trusted terminal processor result or successful cancellation.';
COMMENT ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text) IS
  'Service-role-only wrapper for exact processor-confirmed payment reconciliation.';

NOTIFY pgrst, 'reload schema';
COMMIT;
