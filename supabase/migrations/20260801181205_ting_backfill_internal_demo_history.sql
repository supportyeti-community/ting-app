-- ============================================================================
-- TinG: Backfill historical internal-demo tenant mappings
-- ============================================================================
--
-- REVIEW STATUS
--   Review-only execution candidate. Nothing in this file has been executed.
--
-- VERIFIED LIVE SNAPSHOT (2 August 2026, Australia/Adelaide)
--   - TinG has one registered internal demo: the-bistro.
--   - public.tenants has exactly the canonical the-bistro tenant.
--   - public.tenant_memberships is empty.
--   - menu_events has 38 the-bistro rows with NULL tenant_id.
--   - service_tickets has 4 internal-demo rows with NULL tenant_id.
--   - restaurant_settings, menu_items, and table_configurations are empty.
--
-- THIS MIGRATION
--   - Maps the 38 historical the-bistro menu_events through client_slug.
--   - Maps the 4 historical service_tickets under the reviewed closed-world
--     internal-demo classification. service_tickets has no client_slug or other
--     restaurant relationship, so the exact four-row snapshot is deliberately
--     classified by a pinned four-row content shape; count or content drift
--     requires renewed review.
--   - Is rerunnable only while the pinned historical snapshot remains unchanged.
--   - Preserves every non-tenant value and verifies the result before commit.
--
-- EXPECTED OPERATIONAL EFFECT
--   - service_tickets is in the supabase_realtime publication, so its four
--     UPDATEs may be delivered to connected demo subscribers. This requires
--     immediate post-migration Realtime and application verification.
--
-- THIS MIGRATION DOES NOT
--   - Create tenants, customers, or memberships.
--   - Change RLS, grants, policies, functions, triggers, constraints, routing,
--     client_slug, Storage, frontend code, or tenant_id nullability.
--   - Assign future rows or enforce tenant isolation.
-- ============================================================================

BEGIN;

-- Freeze the reviewed classification and rows for the duration of the backfill.
LOCK TABLE
    public.tenants,
    public.tenant_memberships,
    public.restaurant_clients,
    public.restaurant_settings,
    public.menu_items,
    public.service_tickets,
    public.table_configurations,
    public.menu_events
IN SHARE ROW EXCLUSIVE MODE;

-- Preserve the complete service-ticket payload so the existing BEFORE UPDATE
-- sanitizer cannot silently alter historical values during the tenant update.
CREATE TEMPORARY TABLE ting_backfill_service_ticket_snapshot
ON COMMIT DROP
AS
SELECT *
FROM public.service_tickets;

DO $migration$
DECLARE
    demo_tenant_id UUID;
    updated_event_count BIGINT;
    updated_ticket_count BIGINT;
BEGIN
    -- Required stage objects must exist.
    IF to_regclass('public.tenants') IS NULL
       OR to_regclass('public.tenant_memberships') IS NULL
       OR to_regclass('public.restaurant_clients') IS NULL
       OR to_regclass('public.restaurant_settings') IS NULL
       OR to_regclass('public.menu_items') IS NULL
       OR to_regclass('public.service_tickets') IS NULL
       OR to_regclass('public.table_configurations') IS NULL
       OR to_regclass('public.menu_events') IS NULL THEN
        RAISE EXCEPTION 'Required TinG table is missing';
    END IF;

    -- Pin the staged five-table tenant_id shape.
    IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
              'restaurant_settings', 'menu_items', 'service_tickets',
              'table_configurations', 'menu_events'
          )
          AND column_name = 'tenant_id'
          AND data_type = 'uuid'
          AND is_nullable = 'YES'
    ) <> 5 THEN
        RAISE EXCEPTION 'Expected five nullable UUID operational tenant_id columns';
    END IF;

    -- Only menu_items and menu_events may carry the legacy routing key.
    IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
              'restaurant_settings', 'menu_items', 'service_tickets',
              'table_configurations', 'menu_events'
          )
          AND column_name = 'client_slug'
    ) <> 2
       OR (
           SELECT count(*)
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN ('menu_items', 'menu_events')
             AND column_name = 'client_slug'
             AND data_type = 'text'
             AND is_nullable = 'NO'
       ) <> 2 THEN
        RAISE EXCEPTION 'Operational client_slug shape has drifted';
    END IF;

    -- All five tenant foreign keys must remain validated and point at tenants.id.
    IF (
        SELECT count(*)
        FROM pg_constraint AS constraint_record
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid IN (
              'public.restaurant_settings'::regclass,
              'public.menu_items'::regclass,
              'public.service_tickets'::regclass,
              'public.table_configurations'::regclass,
              'public.menu_events'::regclass
          )
          AND constraint_record.confrelid = 'public.tenants'::regclass
          AND constraint_record.convalidated
          AND pg_get_constraintdef(constraint_record.oid) =
              'FOREIGN KEY (tenant_id) REFERENCES tenants(id)'
    ) <> 5 THEN
        RAISE EXCEPTION 'Operational tenant foreign-key foundation has drifted';
    END IF;

    -- Closed-world internal-demo classification: one registry row, one matching
    -- tenant, and no memberships or competing tenant identity.
    IF (SELECT count(*) FROM public.restaurant_clients) <> 1
       OR NOT EXISTS (
           SELECT 1 FROM public.restaurant_clients
           WHERE client_slug = 'the-bistro'
             AND restaurant_name = 'The Bistro'
       ) THEN
        RAISE EXCEPTION 'Expected only the reviewed The Bistro demo registry row';
    END IF;

    IF (SELECT count(*) FROM public.tenants) <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one internal-demo tenant';
    END IF;

    SELECT id
    INTO STRICT demo_tenant_id
    FROM public.tenants
    WHERE client_slug = 'the-bistro';

    IF (SELECT count(*) FROM public.tenant_memberships) <> 0 THEN
        RAISE EXCEPTION 'Tenant memberships exist; identity scope requires review';
    END IF;

    -- Pin the complete historical snapshot. Any new data requires re-review
    -- instead of being silently classified by this one-time migration.
    IF (SELECT count(*) FROM public.restaurant_settings) <> 0
       OR (SELECT count(*) FROM public.menu_items) <> 0
       OR (SELECT count(*) FROM public.table_configurations) <> 0
       OR (SELECT count(*) FROM public.menu_events) <> 38
       OR (SELECT count(*) FROM public.service_tickets) <> 4 THEN
        RAISE EXCEPTION 'Historical demo-data counts drifted from the reviewed snapshot';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.menu_events
        WHERE client_slug IS DISTINCT FROM 'the-bistro'
           OR (
               tenant_id IS DISTINCT FROM demo_tenant_id
               AND tenant_id IS NOT NULL
           )
    ) THEN
        RAISE EXCEPTION 'menu_events contains an unexpected slug or tenant mapping';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.service_tickets
        WHERE tenant_id IS NOT NULL
          AND tenant_id IS DISTINCT FROM demo_tenant_id
    ) THEN
        RAISE EXCEPTION 'service_tickets contains a competing tenant mapping';
    END IF;

    -- Pin the reviewed content shape of the four unscoped tickets manually
    -- classified as internal demo data. Generated row IDs are intentionally not
    -- hardcoded; count or content drift blocks automatic execution.
    IF (SELECT count(*) FROM public.service_tickets WHERE table_number = 'Unknown') <> 4
       OR (SELECT count(*) FROM public.service_tickets
           WHERE request_type IN ('👋 Server Requested', '💧 Water Refill')) <> 4 THEN
        RAISE EXCEPTION 'Historical service-ticket identity drifted';
    END IF;

    UPDATE public.menu_events
    SET tenant_id = demo_tenant_id
    WHERE client_slug = 'the-bistro'
      AND tenant_id IS NULL;
    GET DIAGNOSTICS updated_event_count = ROW_COUNT;

    UPDATE public.service_tickets
    SET tenant_id = demo_tenant_id
    WHERE tenant_id IS NULL;
    GET DIAGNOSTICS updated_ticket_count = ROW_COUNT;

    -- First execution updates 38 + 4 rows; a clean rerun updates 0 + 0.
    IF updated_event_count NOT IN (0, 38)
       OR updated_ticket_count NOT IN (0, 4) THEN
        RAISE EXCEPTION
            'Unexpected backfill counts: menu_events %, service_tickets %',
            updated_event_count, updated_ticket_count;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.menu_events
        WHERE client_slug IS DISTINCT FROM 'the-bistro'
           OR tenant_id IS DISTINCT FROM demo_tenant_id
    )
       OR EXISTS (
           SELECT 1 FROM public.service_tickets
           WHERE tenant_id IS DISTINCT FROM demo_tenant_id
       ) THEN
        RAISE EXCEPTION 'Historical tenant backfill verification failed';
    END IF;

    -- The service-ticket UPDATE trigger must not change any other field.
    IF EXISTS (
        (SELECT id, table_number, request_type, status, created_at
         FROM public.service_tickets
         EXCEPT
         SELECT id, table_number, request_type, status, created_at
         FROM ting_backfill_service_ticket_snapshot)
        UNION ALL
        (SELECT id, table_number, request_type, status, created_at
         FROM ting_backfill_service_ticket_snapshot
         EXCEPT
         SELECT id, table_number, request_type, status, created_at
         FROM public.service_tickets)
    ) THEN
        RAISE EXCEPTION 'A non-tenant service-ticket value changed during backfill';
    END IF;

    -- Empty staged tables must remain empty and no membership may appear.
    IF (SELECT count(*) FROM public.restaurant_settings) <> 0
       OR (SELECT count(*) FROM public.menu_items) <> 0
       OR (SELECT count(*) FROM public.table_configurations) <> 0
       OR (SELECT count(*) FROM public.tenant_memberships) <> 0 THEN
        RAISE EXCEPTION 'Out-of-scope table changed during backfill';
    END IF;
END;
$migration$;

COMMIT;
