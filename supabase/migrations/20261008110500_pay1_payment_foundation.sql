-- PAY-1: split-aware payment foundation.
-- Repository-only migration. Do not apply to production until explicitly approved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.orders
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid',
  ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('unpaid','partially_paid','paid'));

CREATE TABLE public.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'unassigned',
  provider_payment_id text,
  client_request_id uuid NOT NULL,
  requested_amount numeric(12,2) NOT NULL,
  confirmed_amount numeric(12,2),
  currency text NOT NULL DEFAULT 'AUD',
  status text NOT NULL DEFAULT 'created',
  reservation_expires_at timestamptz NOT NULL,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT payment_attempts_provider_clean CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  CONSTRAINT payment_attempts_requested_positive CHECK (requested_amount > 0),
  CONSTRAINT payment_attempts_confirmed_nonnegative CHECK (confirmed_amount IS NULL OR confirmed_amount >= 0),
  CONSTRAINT payment_attempts_confirmed_not_over_requested CHECK (confirmed_amount IS NULL OR confirmed_amount <= requested_amount),
  CONSTRAINT payment_attempts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_attempts_status_check CHECK (status IN ('created','pending','succeeded','failed','cancelled','expired')),
  CONSTRAINT payment_attempts_tenant_client_request_key UNIQUE (tenant_id, client_request_id),
  CONSTRAINT payment_attempts_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT payment_attempts_tenant_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX payment_attempts_provider_reference_key
  ON public.payment_attempts(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payment_attempts_tenant_order_created_idx
  ON public.payment_attempts(tenant_id, order_id, created_at DESC);
CREATE INDEX payment_attempts_active_reservation_idx
  ON public.payment_attempts(tenant_id, order_id, reservation_expires_at)
  WHERE status IN ('created','pending');

CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  payment_attempt_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'AUD',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_allocations_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_allocations_one_per_attempt UNIQUE (payment_attempt_id),
  CONSTRAINT payment_allocations_tenant_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES public.orders(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_tenant_attempt_fk
    FOREIGN KEY (tenant_id, payment_attempt_id)
    REFERENCES public.payment_attempts(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX payment_allocations_tenant_order_idx
  ON public.payment_allocations(tenant_id, order_id, created_at DESC);

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payment_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_attempts TO authenticated;
GRANT SELECT ON public.payment_allocations TO authenticated;

CREATE POLICY payment_attempts_member_read
ON public.payment_attempts FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

CREATE POLICY payment_allocations_member_read
ON public.payment_allocations FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

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
    AND a.status IN ('created','pending')
    AND a.reservation_expires_at > now();

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
REVOKE ALL ON FUNCTION ting_private.payment_balance(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;

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
    AND status IN ('created','pending')
    AND reservation_expires_at <= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$function$;

ALTER FUNCTION ting_private.expire_payment_reservations(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.expire_payment_reservations(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION ting_private.create_payment_attempt(
  p_order_id uuid,
  p_requested_amount numeric,
  p_client_request_id uuid
)
RETURNS public.payment_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  normalized_amount numeric(12,2);
  existing_attempt public.payment_attempts%ROWTYPE;
  created_attempt public.payment_attempts%ROWTYPE;
  balance record;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'payment attempt requires a valid tenant route' USING errcode = '23514';
  END IF;
  IF p_order_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'order_id and client_request_id are required' USING errcode = '23514';
  END IF;

  normalized_amount := round(p_requested_amount,2);
  IF normalized_amount IS NULL OR normalized_amount <= 0 THEN
    RAISE EXCEPTION 'payment amount must be positive' USING errcode = '23514';
  END IF;

  SELECT * INTO existing_attempt
  FROM public.payment_attempts
  WHERE tenant_id = routed_tenant_id
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN existing_attempt;
  END IF;

  PERFORM ting_private.expire_payment_reservations(routed_tenant_id, p_order_id);

  SELECT * INTO balance
  FROM ting_private.payment_balance(p_order_id, routed_tenant_id, true);

  IF balance.amount_due <= 0 THEN
    RAISE EXCEPTION 'order is already fully paid' USING errcode = '23514';
  END IF;
  IF normalized_amount > balance.amount_available THEN
    RAISE EXCEPTION 'payment amount exceeds currently available balance' USING errcode = '23514';
  END IF;

  BEGIN
    INSERT INTO public.payment_attempts(
      tenant_id, order_id, client_request_id, requested_amount,
      currency, status, reservation_expires_at
    ) VALUES (
      routed_tenant_id, p_order_id, p_client_request_id, normalized_amount,
      'AUD', 'created', now() + interval '10 minutes'
    )
    RETURNING * INTO created_attempt;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO created_attempt
    FROM public.payment_attempts
    WHERE tenant_id = routed_tenant_id
      AND client_request_id = p_client_request_id;
    IF NOT FOUND THEN RAISE; END IF;
  END;

  RETURN created_attempt;
END;
$function$;

ALTER FUNCTION ting_private.create_payment_attempt(uuid,numeric,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.create_payment_attempt(uuid,numeric,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_payment_attempt(
  p_order_id uuid,
  p_requested_amount numeric,
  p_client_request_id uuid
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.create_payment_attempt(p_order_id,p_requested_amount,p_client_request_id);
$function$;

REVOKE ALL ON FUNCTION public.create_payment_attempt(uuid,numeric,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_payment_attempt(uuid,numeric,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.create_payment_attempt(uuid,numeric,uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_order_payment_balance(p_order_id uuid)
RETURNS TABLE(
  order_total numeric(12,2),
  amount_paid numeric(12,2),
  amount_reserved numeric(12,2),
  amount_due numeric(12,2),
  amount_available numeric(12,2),
  payment_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'payment balance requires a valid tenant route' USING errcode = '23514';
  END IF;
  RETURN QUERY SELECT * FROM ting_private.payment_balance(p_order_id,routed_tenant_id,false);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_order_payment_balance(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_payment_balance(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.payment_balance(uuid,uuid,boolean) TO anon, authenticated;

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
  paid numeric(12,2);
  order_total numeric(12,2);
BEGIN
  normalized_amount := round(p_confirmed_amount,2);
  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501'; END IF;

  IF attempt.status = 'succeeded' THEN
    IF attempt.provider = p_provider
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
  SET provider = lower(p_provider),
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
REVOKE ALL ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text) TO service_role;

COMMENT ON TABLE public.payment_attempts IS
  'Tenant-owned payment attempts. Pending attempts reserve order balance for a bounded window; browser clients cannot write this table directly.';
COMMENT ON TABLE public.payment_allocations IS
  'Server-recognized successful money allocated to an order. These rows, not browser success state, reduce the outstanding balance.';
COMMENT ON FUNCTION public.create_payment_attempt(uuid,numeric,uuid) IS
  'Route-bound idempotent reservation of an amount against the current unpaid order balance. No processor call occurs in PAY-1.';
COMMENT ON FUNCTION public.get_order_payment_balance(uuid) IS
  'Route-bound derived payment balance for an order: total, paid, active reservations, due and currently available amount.';
COMMENT ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,numeric,text) IS
  'Trusted-server reconciliation primitive for a processor-confirmed successful payment. PAY-2 will place verified webhook handling in front of this function.';

NOTIFY pgrst, 'reload schema';
COMMIT;
