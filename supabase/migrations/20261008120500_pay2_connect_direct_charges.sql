-- PAY-2: Stripe Connect direct-charge account binding.
-- Restaurant connected accounts are canonical server-side tenant state.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.tenant_payment_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_payment_accounts_provider_check CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  CONSTRAINT tenant_payment_accounts_account_check CHECK (length(trim(provider_account_id)) BETWEEN 1 AND 255),
  CONSTRAINT tenant_payment_accounts_status_check CHECK (status IN ('active','disabled')),
  CONSTRAINT tenant_payment_accounts_tenant_provider_unique UNIQUE (tenant_id, provider),
  CONSTRAINT tenant_payment_accounts_provider_account_unique UNIQUE (provider, provider_account_id)
);

ALTER TABLE public.tenant_payment_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_payment_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_payment_accounts TO service_role;

ALTER TABLE public.payment_attempts
  ADD COLUMN IF NOT EXISTS provider_account_id text;

CREATE INDEX IF NOT EXISTS payment_attempts_provider_account_idx
  ON public.payment_attempts(provider, provider_account_id)
  WHERE provider_account_id IS NOT NULL;

-- Retire PAY-2 pre-Connect public wrappers so processor-bound mutations cannot
-- omit the connected-account context.
DROP FUNCTION IF EXISTS public.bind_payment_provider(uuid,text,text);
DROP FUNCTION IF EXISTS public.release_payment_attempt(uuid,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.confirm_payment_attempt_trusted(uuid,text,text,numeric,text);
DROP FUNCTION IF EXISTS ting_private.bind_payment_provider(uuid,text,text);
DROP FUNCTION IF EXISTS ting_private.release_payment_attempt(uuid,text,text,text,text,text);

CREATE OR REPLACE FUNCTION ting_private.bind_payment_provider(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
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
  normalized_account text;
  updated_attempt public.payment_attempts%ROWTYPE;
BEGIN
  normalized_provider := lower(trim(COALESCE(p_provider,'')));
  normalized_account := trim(COALESCE(p_provider_account_id,''));
  IF normalized_provider !~ '^[a-z0-9_-]{1,40}$'
     OR normalized_account = ''
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

  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_payment_accounts a
    WHERE a.tenant_id = attempt.tenant_id
      AND a.provider = normalized_provider
      AND a.provider_account_id = normalized_account
      AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'tenant payment account unavailable' USING errcode='42501';
  END IF;

  IF attempt.status = 'pending' THEN
    IF attempt.provider = normalized_provider
       AND attempt.provider_account_id = normalized_account
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
      provider_account_id = normalized_account,
      provider_payment_id = p_provider_payment_id,
      status = 'pending',
      reservation_expires_at = now() + interval '30 minutes',
      updated_at = now()
  WHERE id = p_attempt_id
  RETURNING * INTO updated_attempt;
  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.bind_payment_provider(uuid,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.bind_payment_provider(uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.bind_payment_provider(uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.bind_payment_provider(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
  p_provider_payment_id text
)
RETURNS public.payment_attempts
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT ting_private.bind_payment_provider(p_attempt_id,p_provider,p_provider_account_id,p_provider_payment_id);
$function$;

REVOKE ALL ON FUNCTION public.bind_payment_provider(uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_payment_provider(uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION ting_private.release_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
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
  normalized_account text;
  normalized_status text;
  updated_attempt public.payment_attempts%ROWTYPE;
BEGIN
  normalized_provider := lower(trim(COALESCE(p_provider,'')));
  normalized_account := trim(COALESCE(p_provider_account_id,''));
  normalized_status := lower(trim(COALESCE(p_terminal_status,'')));
  IF normalized_status NOT IN ('failed','cancelled','expired') THEN
    RAISE EXCEPTION 'invalid releasing terminal status' USING errcode='23514';
  END IF;

  SELECT * INTO attempt
  FROM public.payment_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501'; END IF;

  IF attempt.provider <> normalized_provider
     OR attempt.provider_account_id IS DISTINCT FROM normalized_account
     OR attempt.provider_payment_id IS DISTINCT FROM p_provider_payment_id THEN
    RAISE EXCEPTION 'payment provider reference mismatch' USING errcode='23514';
  END IF;

  IF attempt.status IN ('failed','cancelled','expired') THEN RETURN attempt; END IF;
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

ALTER FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.release_payment_attempt(uuid,text,text,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.release_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
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
    p_attempt_id,p_provider,p_provider_account_id,p_provider_payment_id,p_terminal_status,p_failure_code,p_failure_message
  );
$function$;

REVOKE ALL ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_attempt(uuid,text,text,text,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION ting_private.confirm_payment_attempt(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
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
  normalized_account text;
  paid numeric(12,2);
  order_total numeric(12,2);
BEGIN
  normalized_amount := round(p_confirmed_amount,2);
  normalized_provider := lower(trim(COALESCE(p_provider,'')));
  normalized_account := trim(COALESCE(p_provider_account_id,''));

  SELECT * INTO attempt FROM public.payment_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501'; END IF;

  IF attempt.status = 'succeeded' THEN
    IF attempt.provider = normalized_provider
       AND attempt.provider_account_id = normalized_account
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
  IF attempt.provider_payment_id IS NOT NULL AND (
       attempt.provider <> normalized_provider
       OR attempt.provider_account_id IS DISTINCT FROM normalized_account
       OR attempt.provider_payment_id <> p_provider_payment_id
  ) THEN
    RAISE EXCEPTION 'payment provider reference mismatch' USING errcode='23514';
  END IF;
  IF normalized_amount IS NULL OR normalized_amount <= 0 OR normalized_amount <> attempt.requested_amount THEN
    RAISE EXCEPTION 'confirmed amount mismatch' USING errcode='23514';
  END IF;
  IF upper(COALESCE(p_currency,'')) <> attempt.currency THEN
    RAISE EXCEPTION 'currency mismatch' USING errcode='23514';
  END IF;

  SELECT total INTO order_total FROM public.orders
  WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id FOR UPDATE;
  SELECT COALESCE(round(sum(amount),2),0) INTO paid FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;
  IF paid + normalized_amount > order_total THEN
    RAISE EXCEPTION 'payment would exceed order total' USING errcode='23514';
  END IF;

  UPDATE public.payment_attempts
  SET provider=normalized_provider,
      provider_account_id=normalized_account,
      provider_payment_id=p_provider_payment_id,
      confirmed_amount=normalized_amount,
      status='succeeded',
      confirmed_at=now(),
      updated_at=now()
  WHERE id=attempt.id RETURNING * INTO updated_attempt;

  INSERT INTO public.payment_allocations(tenant_id,order_id,payment_attempt_id,amount,currency)
  VALUES (attempt.tenant_id,attempt.order_id,attempt.id,normalized_amount,attempt.currency)
  ON CONFLICT (payment_attempt_id) DO NOTHING;

  SELECT COALESCE(round(sum(amount),2),0) INTO paid FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;
  UPDATE public.orders
  SET payment_status=CASE WHEN paid<=0 THEN 'unpaid' WHEN paid<total THEN 'partially_paid' ELSE 'paid' END,
      updated_at=now()
  WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id;
  RETURN updated_attempt;
END;
$function$;

ALTER FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_payment_attempt_trusted(
  p_attempt_id uuid,
  p_provider text,
  p_provider_account_id text,
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
    p_attempt_id,p_provider,p_provider_account_id,p_provider_payment_id,p_confirmed_amount,p_currency
  );
$function$;

REVOKE ALL ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payment_attempt_trusted(uuid,text,text,text,numeric,text) TO service_role;

COMMENT ON TABLE public.tenant_payment_accounts IS
  'Server-managed tenant to payment-provider account mapping. No KYC, bank, card, or provider secret data is stored here.';
COMMENT ON COLUMN public.payment_attempts.provider_account_id IS
  'Snapshot of the provider account context used for this processor attempt; for Stripe Connect this is the connected account id.';

NOTIFY pgrst, 'reload schema';
COMMIT;
