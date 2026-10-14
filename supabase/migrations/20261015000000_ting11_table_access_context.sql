-- TING-11 hardening: bind anonymous order submission to an issued tenant/table capability.
-- Repository-only migration. Do not apply to production until explicitly approved and rehearsed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.table_access_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  table_number text NOT NULL,
  token_hash bytea NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT table_access_contexts_table_number_clean
    CHECK (table_number ~ '^[A-Za-z0-9 _-]{1,20}$'),
  CONSTRAINT table_access_contexts_token_hash_length
    CHECK (octet_length(token_hash) = 32),
  CONSTRAINT table_access_contexts_tenant_token_key
    UNIQUE (tenant_id, token_hash)
);

CREATE INDEX table_access_contexts_active_table_idx
  ON public.table_access_contexts (tenant_id, table_number)
  WHERE revoked_at IS NULL;

ALTER TABLE public.table_access_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.table_access_contexts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION ting_private.issue_table_access_context(p_table_number text)
RETURNS TABLE(context_id uuid, table_number text, token text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  normalized_table text;
  raw_token text;
  inserted_id uuid;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL
     OR (SELECT auth.uid()) IS NULL
     OR NOT ting_private.can_manage_tenant(routed_tenant_id) THEN
    RAISE EXCEPTION 'tenant management authorization required'
      USING errcode = '42501';
  END IF;

  normalized_table := trim(COALESCE(p_table_number, ''));
  IF normalized_table !~ '^[A-Za-z0-9 _-]{1,20}$' THEN
    RAISE EXCEPTION 'invalid table context' USING errcode = '23514';
  END IF;

  raw_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO public.table_access_contexts (
    tenant_id,
    table_number,
    token_hash,
    created_by
  ) VALUES (
    routed_tenant_id,
    normalized_table,
    extensions.digest(raw_token, 'sha256'),
    (SELECT auth.uid())
  )
  RETURNING id INTO inserted_id;

  RETURN QUERY SELECT inserted_id, normalized_table, raw_token;
END;
$function$;

ALTER FUNCTION ting_private.issue_table_access_context(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.issue_table_access_context(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.issue_table_access_context(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.issue_table_access_context(p_table_number text)
RETURNS TABLE(context_id uuid, table_number text, token text)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT * FROM ting_private.issue_table_access_context(p_table_number);
$function$;

REVOKE ALL ON FUNCTION public.issue_table_access_context(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.issue_table_access_context(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION ting_private.table_access_context_is_valid(
  p_tenant_id uuid,
  p_table_number text,
  p_token text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_tenant_id IS NULL
      OR p_table_number IS NULL
      OR p_token IS NULL
      OR p_token !~ '^[0-9a-fA-F]{64}$'
      THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.table_access_contexts context
      WHERE context.tenant_id = p_tenant_id
        AND context.table_number = trim(p_table_number)
        AND context.revoked_at IS NULL
        AND context.token_hash = extensions.digest(lower(p_token), 'sha256')
    )
  END;
$function$;

ALTER FUNCTION ting_private.table_access_context_is_valid(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.table_access_context_is_valid(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the previously certified ordering implementation behind a private,
-- non-callable helper. The new public path must prove table possession first.
DROP FUNCTION public.submit_order(text, uuid, jsonb);
REVOKE ALL ON FUNCTION ting_private.submit_order(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION ting_private.submit_order(text, uuid, jsonb)
  RENAME TO submit_order_unverified;
REVOKE ALL ON FUNCTION ting_private.submit_order_unverified(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION ting_private.submit_order(
  p_table_number text,
  p_client_request_id uuid,
  p_items jsonb,
  p_table_token text
)
RETURNS public.orders
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  normalized_table text;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'order submission requires a valid tenant route'
      USING errcode = '23514';
  END IF;

  normalized_table := trim(COALESCE(p_table_number, ''));
  IF NOT ting_private.table_access_context_is_valid(
    routed_tenant_id,
    normalized_table,
    p_table_token
  ) THEN
    RAISE EXCEPTION 'valid table access context required'
      USING errcode = '42501';
  END IF;

  RETURN ting_private.submit_order_unverified(
    normalized_table,
    p_client_request_id,
    p_items
  );
END;
$function$;

ALTER FUNCTION ting_private.submit_order(text, uuid, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.submit_order(text, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.submit_order(text, uuid, jsonb, text)
  TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_order(
  p_table_number text,
  p_client_request_id uuid,
  p_items jsonb,
  p_table_token text DEFAULT NULL
)
RETURNS public.orders
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT ting_private.submit_order(
    p_table_number,
    p_client_request_id,
    p_items,
    p_table_token
  );
$function$;

REVOKE ALL ON FUNCTION public.submit_order(text, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_order(text, uuid, jsonb, text)
  TO anon, authenticated;

COMMENT ON TABLE public.table_access_contexts IS
  'Hashed bearer capabilities issued by an authorized tenant manager for a specific physical table. Tokens are never stored in plaintext.';
COMMENT ON FUNCTION public.issue_table_access_context(text) IS
  'Tenant-manager-only issuance of a one-time-returned 256-bit table bearer capability for QR/NFC links.';
COMMENT ON FUNCTION public.submit_order(text, uuid, jsonb, text) IS
  'Route-bound and table-capability-bound idempotent order submission. Tenant, table possession, menu ownership, stock and pricing are validated server-side.';
COMMENT ON FUNCTION ting_private.submit_order_unverified(text, uuid, jsonb) IS
  'Previously certified ordering core. Not callable by API roles; invoked only after the table capability gate succeeds.';

NOTIFY pgrst, 'reload schema';
COMMIT;
