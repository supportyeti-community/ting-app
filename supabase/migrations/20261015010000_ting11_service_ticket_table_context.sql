-- TING-11 hardening: require the issued tenant/table capability for guest assistance requests.
-- Repository-only migration. Do not apply to production until explicitly approved and rehearsed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Browser guests must no longer write service_tickets directly. The capability-
-- gated RPC below becomes the only anonymous creation path.
DROP POLICY IF EXISTS service_tickets_routed_insert ON public.service_tickets;
REVOKE INSERT ON public.service_tickets FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ting_private.submit_service_ticket(
  p_id uuid,
  p_table_number text,
  p_request_type text,
  p_table_token text
)
RETURNS public.service_tickets
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  normalized_table text;
  normalized_request_type text;
  inserted_ticket public.service_tickets;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'service ticket submission requires a valid tenant route'
      USING errcode = '23514';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'service ticket id is required'
      USING errcode = '23502';
  END IF;

  normalized_table := trim(COALESCE(p_table_number, ''));
  IF normalized_table !~ '^[A-Za-z0-9 _-]{1,20}$' THEN
    RAISE EXCEPTION 'invalid table context'
      USING errcode = '23514';
  END IF;

  IF NOT ting_private.table_access_context_is_valid(
    routed_tenant_id,
    normalized_table,
    p_table_token
  ) THEN
    RAISE EXCEPTION 'valid table access context required'
      USING errcode = '42501';
  END IF;

  normalized_request_type := trim(COALESCE(p_request_type, ''));
  IF length(normalized_request_type) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid service ticket request type'
      USING errcode = '23514';
  END IF;

  INSERT INTO public.service_tickets (
    id,
    table_number,
    request_type,
    status
  ) VALUES (
    p_id,
    normalized_table,
    normalized_request_type,
    'pending'
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO inserted_ticket;

  IF inserted_ticket.id IS NULL THEN
    SELECT *
      INTO inserted_ticket
      FROM public.service_tickets ticket
     WHERE ticket.id = p_id;

    IF inserted_ticket.id IS NULL
       OR inserted_ticket.tenant_id <> routed_tenant_id
       OR inserted_ticket.table_number <> normalized_table
       OR inserted_ticket.request_type <> normalized_request_type THEN
      RAISE EXCEPTION 'service ticket id already exists with different request details'
        USING errcode = '23505';
    END IF;
  END IF;

  RETURN inserted_ticket;
END;
$function$;

ALTER FUNCTION ting_private.submit_service_ticket(uuid, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.submit_service_ticket(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.submit_service_ticket(uuid, text, text, text)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_service_ticket(
  p_id uuid,
  p_table_number text,
  p_request_type text,
  p_table_token text DEFAULT NULL
)
RETURNS public.service_tickets
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.submit_service_ticket(
    p_id,
    p_table_number,
    p_request_type,
    p_table_token
  );
$function$;

REVOKE ALL ON FUNCTION public.submit_service_ticket(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_service_ticket(uuid, text, text, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.submit_service_ticket(uuid, text, text, text) IS
  'Route-bound and physical-table-capability-bound guest assistance submission. Direct anonymous service_tickets inserts are disabled.';

NOTIFY pgrst, 'reload schema';
COMMIT;
