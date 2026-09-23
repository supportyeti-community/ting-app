-- TING-2 fourth release: route-bound service tickets and tenant-member handling.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.service_tickets IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.tenants IN SHARE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.service_tickets ticket
    LEFT JOIN public.tenants tenant ON tenant.id = ticket.tenant_id
    WHERE ticket.tenant_id IS NULL
       OR tenant.id IS NULL
       OR (
         ticket.client_slug IS NOT NULL
         AND ticket.client_slug IS DISTINCT FROM tenant.client_slug
       )
  ) THEN
    RAISE EXCEPTION 'TING-2 service tickets require explicit, matching tenant ownership';
  END IF;
END $$;

-- Four historical bootstrap tickets predate client_slug. Their tenant_id was
-- already reviewed and backfilled by the foundation migrations; complete the
-- canonical ownership pair before making the routing field required. The
-- existing invariant trigger blocks ownership-field updates, so suspend only
-- that trigger for this guarded, transactional repair.
ALTER TABLE public.service_tickets DISABLE TRIGGER a_assign_service_ticket_tenant;
UPDATE public.service_tickets ticket
SET client_slug = tenant.client_slug
FROM public.tenants tenant
WHERE tenant.id = ticket.tenant_id
  AND ticket.client_slug IS NULL;
ALTER TABLE public.service_tickets ENABLE TRIGGER a_assign_service_ticket_tenant;

ALTER TABLE public.service_tickets
  ALTER COLUMN tenant_id SET NOT NULL,
  ALTER COLUMN client_slug SET NOT NULL;

CREATE OR REPLACE FUNCTION ting_private.assign_service_ticket_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  routed_tenant_id uuid;
  routed_client_slug text;
BEGIN
  IF tg_table_schema <> 'public'
     OR tg_table_name <> 'service_tickets'
     OR tg_when <> 'BEFORE'
     OR tg_level <> 'ROW'
     OR tg_op NOT IN ('INSERT', 'UPDATE') THEN
    RAISE EXCEPTION 'assign_service_ticket_tenant may only run as the approved public.service_tickets row trigger'
      USING errcode = '42501';
  END IF;

  IF tg_op = 'UPDATE' THEN
    IF new.id IS DISTINCT FROM old.id
       OR new.tenant_id IS DISTINCT FROM old.tenant_id
       OR new.client_slug IS DISTINCT FROM old.client_slug
       OR new.table_number IS DISTINCT FROM old.table_number
       OR new.request_type IS DISTINCT FROM old.request_type
       OR new.created_at IS DISTINCT FROM old.created_at THEN
      RAISE EXCEPTION 'service ticket request details and ownership are immutable'
        USING errcode = '23514';
    END IF;
    RETURN new;
  END IF;

  routed_tenant_id := ting_private.request_tenant_id();
  IF routed_tenant_id IS NULL THEN
    RAISE EXCEPTION 'service ticket insert requires a valid tenant route'
      USING errcode = '23514';
  END IF;

  SELECT tenant.client_slug
    INTO routed_client_slug
    FROM public.tenants tenant
   WHERE tenant.id = routed_tenant_id;

  IF new.tenant_id IS NOT NULL AND new.tenant_id <> routed_tenant_id THEN
    RAISE EXCEPTION 'tenant_id does not match the request route'
      USING errcode = '23514';
  END IF;
  IF new.client_slug IS NOT NULL AND new.client_slug <> routed_client_slug THEN
    RAISE EXCEPTION 'client_slug does not match the request route'
      USING errcode = '23514';
  END IF;

  new.tenant_id := routed_tenant_id;
  new.client_slug := routed_client_slug;
  RETURN new;
END;
$function$;

ALTER FUNCTION ting_private.assign_service_ticket_tenant() OWNER TO postgres;
REVOKE ALL ON FUNCTION ting_private.assign_service_ticket_tenant() FROM PUBLIC, anon, authenticated;

DROP POLICY "Admins can delete service tickets" ON public.service_tickets;
DROP POLICY "Admins can read service tickets" ON public.service_tickets;
DROP POLICY "Admins can update service tickets" ON public.service_tickets;
DROP POLICY "Public can create pending service tickets" ON public.service_tickets;

REVOKE ALL ON public.service_tickets FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.service_tickets TO anon;
GRANT SELECT, INSERT, UPDATE ON public.service_tickets TO authenticated;

CREATE POLICY service_tickets_routed_insert
ON public.service_tickets FOR INSERT TO anon, authenticated
WITH CHECK (
  tenant_id = (SELECT ting_private.request_tenant_id())
  AND status = 'pending'
  AND table_number ~ '^[A-Za-z0-9 _-]{1,20}$'
  AND request_type IS NOT NULL
  AND length(trim(request_type)) BETWEEN 1 AND 500
);

CREATE POLICY service_tickets_member_read
ON public.service_tickets FOR SELECT TO authenticated
USING (ting_private.can_manage_tenant(tenant_id));

CREATE POLICY service_tickets_member_update
ON public.service_tickets FOR UPDATE TO authenticated
USING (ting_private.can_manage_tenant(tenant_id))
WITH CHECK (
  ting_private.can_manage_tenant(tenant_id)
  AND status IN ('pending', 'resolved')
);

COMMENT ON TABLE public.service_tickets IS
  'Tenant-routed assistance queue: public pending inserts; tenant member read/status update; no client delete while Postgres Changes is published.';

NOTIFY pgrst, 'reload schema';
COMMIT;
