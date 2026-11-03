-- PAY-2 hardening: an unbound Stripe confirmation must come from the tenant's active mapped account.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION ting_private.confirm_payment_attempt(
  p_attempt_id uuid,p_provider text,p_provider_account_id text,p_provider_payment_id text,p_confirmed_amount numeric,p_currency text
)
RETURNS public.payment_attempts LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE attempt public.payment_attempts%ROWTYPE; updated_attempt public.payment_attempts%ROWTYPE;
        normalized_amount numeric(12,2); normalized_provider text; normalized_account text; paid numeric(12,2); order_total numeric(12,2);
BEGIN
  normalized_amount:=round(p_confirmed_amount,2);
  normalized_provider:=lower(trim(COALESCE(p_provider,'')));
  normalized_account:=trim(COALESCE(p_provider_account_id,''));
  SELECT * INTO attempt FROM public.payment_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment attempt unavailable' USING errcode='42501'; END IF;
  IF attempt.status='succeeded' THEN
    IF attempt.provider=normalized_provider AND attempt.provider_account_id=normalized_account
       AND attempt.provider_payment_id=p_provider_payment_id AND attempt.confirmed_amount=normalized_amount
       AND attempt.currency=upper(p_currency) THEN RETURN attempt; END IF;
    RAISE EXCEPTION 'payment confirmation mismatch' USING errcode='23514';
  END IF;
  IF attempt.status NOT IN ('created','pending') THEN RAISE EXCEPTION 'payment attempt is not confirmable' USING errcode='23514'; END IF;
  IF attempt.provider_payment_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenant_payment_accounts a
    WHERE a.tenant_id=attempt.tenant_id AND a.provider=normalized_provider
      AND a.provider_account_id=normalized_account AND a.status='active'
  ) THEN RAISE EXCEPTION 'tenant payment account unavailable' USING errcode='42501'; END IF;
  IF attempt.provider_payment_id IS NOT NULL AND (
       attempt.provider<>normalized_provider OR attempt.provider_account_id IS DISTINCT FROM normalized_account
       OR attempt.provider_payment_id<>p_provider_payment_id
  ) THEN RAISE EXCEPTION 'payment provider reference mismatch' USING errcode='23514'; END IF;
  IF normalized_amount IS NULL OR normalized_amount<=0 OR normalized_amount<>attempt.requested_amount THEN
    RAISE EXCEPTION 'confirmed amount mismatch' USING errcode='23514';
  END IF;
  IF upper(COALESCE(p_currency,''))<>attempt.currency THEN RAISE EXCEPTION 'currency mismatch' USING errcode='23514'; END IF;
  SELECT total INTO order_total FROM public.orders WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id FOR UPDATE;
  SELECT COALESCE(round(sum(amount),2),0) INTO paid FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;
  IF paid+normalized_amount>order_total THEN RAISE EXCEPTION 'payment would exceed order total' USING errcode='23514'; END IF;
  UPDATE public.payment_attempts
  SET provider=normalized_provider, provider_account_id=normalized_account, provider_payment_id=p_provider_payment_id,
      confirmed_amount=normalized_amount, status='succeeded', confirmed_at=now(), updated_at=now()
  WHERE id=attempt.id RETURNING * INTO updated_attempt;
  INSERT INTO public.payment_allocations(tenant_id,order_id,payment_attempt_id,amount,currency)
  VALUES (attempt.tenant_id,attempt.order_id,attempt.id,normalized_amount,attempt.currency)
  ON CONFLICT (payment_attempt_id) DO NOTHING;
  SELECT COALESCE(round(sum(amount),2),0) INTO paid FROM public.payment_allocations
  WHERE tenant_id=attempt.tenant_id AND order_id=attempt.order_id;
  UPDATE public.orders
  SET payment_status=CASE WHEN paid<=0 THEN 'unpaid' WHEN paid<total THEN 'partially_paid' ELSE 'paid' END, updated_at=now()
  WHERE id=attempt.order_id AND tenant_id=attempt.tenant_id;
  RETURN updated_attempt;
END;
$function$;
ALTER FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.confirm_payment_attempt(uuid,text,text,text,numeric,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
