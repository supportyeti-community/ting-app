-- PAY-1 hardening: keep public balance RPC invoker-safe and cover composite payment FK.
-- Repository-first migration; production apply only after CI certification.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_order_payment_balance(p_order_id uuid)
RETURNS TABLE(
  order_total numeric(12,2),
  amount_paid numeric(12,2),
  amount_reserved numeric(12,2),
  amount_due numeric(12,2),
  amount_available numeric(12,2),
  payment_status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT *
  FROM ting_private.payment_balance(
    p_order_id,
    ting_private.request_tenant_id(),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.get_order_payment_balance(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_payment_balance(uuid)
  TO anon, authenticated;

CREATE INDEX payment_allocations_tenant_attempt_idx
  ON public.payment_allocations (tenant_id, payment_attempt_id);

COMMENT ON FUNCTION public.get_order_payment_balance(uuid) IS
  'Invoker-safe public wrapper around private route-bound payment balance logic.';

NOTIFY pgrst, 'reload schema';
COMMIT;
