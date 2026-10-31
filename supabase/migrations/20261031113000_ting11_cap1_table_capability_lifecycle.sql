-- CAP-1 / TING-11 hardening: add explicit table-capability revoke and revoke-and-replace lifecycle.
-- Repository-only migration. Do not apply to production until explicitly approved and rehearsed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Coordinate ordinary issuance with rotation for the same routed tenant/table.
-- This preserves the existing issuance contract while preventing an issue call
-- from racing a completed revoke-and-replace operation.
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(routed_tenant_id::text || ':' || normalized_table, 0)
  );

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

CREATE OR REPLACE FUNCTION ting_private.revoke_table_access_context(p_context_id uuid)
RETURNS TABLE(context_id uuid, table_number text, revoked_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  routed_tenant_id uuid;
BEGIN
  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL
     OR (SELECT auth.uid()) IS NULL
     OR NOT ting_private.can_manage_tenant(routed_tenant_id) THEN
    RAISE EXCEPTION 'tenant management authorization required'
      USING errcode = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.table_access_contexts AS context
  SET revoked_at = COALESCE(context.revoked_at, pg_catalog.clock_timestamp())
  WHERE context.id = p_context_id
    AND context.tenant_id = routed_tenant_id
  RETURNING context.id, context.table_number, context.revoked_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'table access context unavailable'
      USING errcode = '42501';
  END IF;
END;
$function$;

ALTER FUNCTION ting_private.revoke_table_access_context(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.revoke_table_access_context(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.revoke_table_access_context(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_table_access_context(p_context_id uuid)
RETURNS TABLE(context_id uuid, table_number text, revoked_at timestamptz)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT * FROM ting_private.revoke_table_access_context(p_context_id);
$function$;

REVOKE ALL ON FUNCTION public.revoke_table_access_context(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_table_access_context(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION ting_private.rotate_table_access_context(p_table_number text)
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

  -- Serialize replacements for one tenant/table so concurrent rotations cannot
  -- leave multiple newly-issued credentials active. Ordinary issuance takes
  -- the same lock, so it cannot cross the revoke-and-replace boundary.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(routed_tenant_id::text || ':' || normalized_table, 0)
  );

  UPDATE public.table_access_contexts AS context
  SET revoked_at = pg_catalog.clock_timestamp()
  WHERE context.tenant_id = routed_tenant_id
    AND context.table_number = normalized_table
    AND context.revoked_at IS NULL;

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

ALTER FUNCTION ting_private.rotate_table_access_context(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.rotate_table_access_context(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION ting_private.rotate_table_access_context(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.rotate_table_access_context(p_table_number text)
RETURNS TABLE(context_id uuid, table_number text, token text)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT * FROM ting_private.rotate_table_access_context(p_table_number);
$function$;

REVOKE ALL ON FUNCTION public.rotate_table_access_context(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rotate_table_access_context(text)
  TO authenticated;

COMMENT ON FUNCTION public.revoke_table_access_context(uuid) IS
  'Tenant-manager-only, retry-safe revocation of one table bearer capability. Cross-tenant and unknown context ids fail closed without disclosure.';
COMMENT ON FUNCTION public.rotate_table_access_context(text) IS
  'Tenant-manager-only atomic revoke-and-replace for a physical table. All active credentials for the routed tenant/table are revoked before one replacement token is returned.';

NOTIFY pgrst, 'reload schema';
COMMIT;
