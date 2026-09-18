-- ============================================================================
-- TinG: Seed the canonical internal demo tenant (v3)
-- ============================================================================
--
-- REVIEW STATUS
--   Review-only execution candidate. Nothing in this file has been executed.
--
-- VERIFIED LIVE STATE (2 August 2026, Australia/Adelaide)
--   - TinG has zero customers.
--   - public.restaurant_clients contains one internal demo: the-bistro.
--   - public.tenants and public.tenant_memberships are empty.
--   - Five operational tables have nullable UUID tenant_id columns.
--   - Only menu_items and menu_events also have client_slug columns.
--   - Existing operational tenant_id values are NULL.
--   - The tenant-assignment triggers on menu_items and menu_events are enabled
--     row-level BEFORE INSERT triggers using
--     ting_private.assign_tenant_id_from_client_slug().
--
-- THIS MIGRATION
--   - Creates exactly one canonical tenant for the internal demo the-bistro.
--   - Is stage-idempotent: it may be rerun unchanged while this seed remains the
--     only tenant and before any tenant_id backfill or membership work begins.
--   - Structurally verifies the five-table tenant foundation.
--   - Audits client_slug on the two tables where that column exists.
--   - Proves both approved assignment triggers with uniquely identified,
--     rollback-only inserts.
--
-- THIS MIGRATION DOES NOT
--   - Create a customer tenant or tenant membership.
--   - Backfill any historical operational row.
--   - Modify RLS, grants, functions, triggers, columns, constraints, Realtime,
--     client_slug routing, Storage, or frontend code.
--   - Make tenant_id NOT NULL.
-- ============================================================================

BEGIN;

-- Stabilise all reviewed state until the transaction commits or rolls back.
-- These locks block concurrent writes but do not alter any object.
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


-- ============================================================================
-- 1. FAIL-CLOSED PREFLIGHT
-- ============================================================================

DO $migration$
DECLARE
    unexpected_slug TEXT;
    tenant_count BIGINT;
    membership_count BIGINT;
    mapped_operational_row_count BIGINT;
    assignment_trigger_count BIGINT;
BEGIN
    IF to_regclass('public.tenants') IS NULL
       OR to_regclass('public.tenant_memberships') IS NULL
       OR to_regclass('public.restaurant_clients') IS NULL
       OR to_regclass('public.restaurant_settings') IS NULL
       OR to_regclass('public.menu_items') IS NULL
       OR to_regclass('public.service_tickets') IS NULL
       OR to_regclass('public.table_configurations') IS NULL
       OR to_regclass('public.menu_events') IS NULL THEN
        RAISE EXCEPTION
            'Required TinG tenant-foundation or operational table is missing';
    END IF;

    -- All five operational tables must have exactly the staged nullable UUID
    -- tenant_id shape approved in Migration 001.
    IF (
        SELECT count(*)
        FROM information_schema.columns AS column_record
        WHERE column_record.table_schema = 'public'
          AND column_record.table_name IN (
              'restaurant_settings',
              'menu_items',
              'service_tickets',
              'table_configurations',
              'menu_events'
          )
          AND column_record.column_name = 'tenant_id'
          AND column_record.data_type = 'uuid'
          AND column_record.is_nullable = 'YES'
    ) <> 5 THEN
        RAISE EXCEPTION
            'Expected five nullable UUID operational tenant_id columns';
    END IF;

    -- Exactly two of the five operational tables may have any client_slug
    -- column. This untyped count fails closed even if an unexpected third
    -- column has a different type or nullability.
    IF (
        SELECT count(*)
        FROM information_schema.columns AS column_record
        WHERE column_record.table_schema = 'public'
          AND column_record.table_name IN (
              'restaurant_settings',
              'menu_items',
              'service_tickets',
              'table_configurations',
              'menu_events'
          )
          AND column_record.column_name = 'client_slug'
    ) <> 2 THEN
        RAISE EXCEPTION
            'Expected client_slug on exactly two operational tables';
    END IF;

    -- Both allowed client_slug columns must retain the reviewed non-null text
    -- shape. Combined with the exact count above, this also proves the other
    -- three operational tables have no client_slug column of any shape.
    IF (
        SELECT count(*)
        FROM information_schema.columns AS column_record
        WHERE column_record.table_schema = 'public'
          AND column_record.table_name IN (
              'restaurant_settings',
              'menu_items',
              'service_tickets',
              'table_configurations',
              'menu_events'
          )
          AND column_record.column_name = 'client_slug'
          AND column_record.data_type = 'text'
          AND column_record.is_nullable = 'NO'
    ) <> 2
       OR NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'menu_items'
             AND column_name = 'client_slug'
       )
       OR NOT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'menu_events'
             AND column_name = 'client_slug'
       ) THEN
        RAISE EXCEPTION
            'Operational client_slug column shape has drifted';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_record
        JOIN pg_attribute AS slug_attribute
          ON slug_attribute.attrelid = constraint_record.conrelid
         AND slug_attribute.attname = 'client_slug'
         AND NOT slug_attribute.attisdropped
        WHERE constraint_record.conrelid = 'public.tenants'::regclass
          AND constraint_record.conname = 'tenants_client_slug_key'
          AND constraint_record.contype = 'u'
          AND constraint_record.conkey
              = ARRAY[slug_attribute.attnum]::SMALLINT[]
    ) THEN
        RAISE EXCEPTION
            'Expected public.tenants client_slug uniqueness constraint is missing or changed';
    END IF;

    -- Pin the UUID-generation assumption used by the seed INSERT.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS id_attribute
        JOIN pg_attrdef AS id_default
          ON id_default.adrelid = id_attribute.attrelid
         AND id_default.adnum = id_attribute.attnum
        WHERE id_attribute.attrelid = 'public.tenants'::regclass
          AND id_attribute.attname = 'id'
          AND id_attribute.atttypid = 'uuid'::regtype
          AND id_attribute.attnotnull
          AND NOT id_attribute.attisdropped
          AND pg_get_expr(
              id_default.adbin,
              id_default.adrelid,
              true
          ) = 'gen_random_uuid()'
    ) THEN
        RAISE EXCEPTION
            'public.tenants.id is not a non-null UUID with the reviewed gen_random_uuid() default';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS table_record
        JOIN pg_namespace AS schema_record
          ON schema_record.oid = table_record.relnamespace
        WHERE schema_record.nspname = 'public'
          AND table_record.relname = 'tenants'
          AND table_record.relkind = 'r'
          AND table_record.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'RLS is not enabled on public.tenants';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policies AS policy_record
        WHERE policy_record.schemaname = 'public'
          AND policy_record.tablename = 'tenants'
    ) THEN
        RAISE EXCEPTION
            'public.tenants unexpectedly has an RLS policy; review access assumptions';
    END IF;

    IF has_table_privilege('anon', 'public.tenants', 'SELECT')
       OR has_table_privilege('anon', 'public.tenants', 'INSERT')
       OR has_table_privilege('authenticated', 'public.tenants', 'SELECT')
       OR has_table_privilege('authenticated', 'public.tenants', 'INSERT') THEN
        RAISE EXCEPTION
            'Client roles unexpectedly have direct public.tenants privileges';
    END IF;

    SELECT count(*)
    INTO tenant_count
    FROM public.tenants;

    IF tenant_count > 1
       OR (
           tenant_count = 1
           AND NOT EXISTS (
               SELECT 1
               FROM public.tenants AS tenant
               WHERE tenant.client_slug = 'the-bistro'
           )
       ) THEN
        RAISE EXCEPTION
            'Unexpected tenant state: expected empty or the-bistro from the same stage seed';
    END IF;

    IF (SELECT count(*) FROM public.restaurant_clients) <> 1
       OR NOT EXISTS (
           SELECT 1
           FROM public.restaurant_clients AS client
           WHERE client.client_slug = 'the-bistro'
       ) THEN
        RAISE EXCEPTION
            'Internal demo registry drifted: expected exactly the-bistro';
    END IF;

    SELECT slug.client_slug
    INTO unexpected_slug
    FROM (
        SELECT item.client_slug
        FROM public.menu_items AS item
        UNION
        SELECT event.client_slug
        FROM public.menu_events AS event
    ) AS slug
    WHERE slug.client_slug IS DISTINCT FROM 'the-bistro'
    LIMIT 1;

    IF unexpected_slug IS NOT NULL THEN
        RAISE EXCEPTION
            'Unexpected operational client_slug found: %', unexpected_slug;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.menu_events AS event
        WHERE event.client_slug = 'the-bistro'
    ) THEN
        RAISE EXCEPTION
            'No existing the-bistro demo data found to justify this mapping';
    END IF;

    SELECT count(*)
    INTO membership_count
    FROM public.tenant_memberships;

    IF membership_count <> 0 THEN
        RAISE EXCEPTION
            'Tenant memberships already exist; identity scope must be reviewed separately';
    END IF;

    SELECT
        (SELECT count(*) FROM public.restaurant_settings WHERE tenant_id IS NOT NULL)
      + (SELECT count(*) FROM public.menu_items WHERE tenant_id IS NOT NULL)
      + (SELECT count(*) FROM public.service_tickets WHERE tenant_id IS NOT NULL)
      + (SELECT count(*) FROM public.table_configurations WHERE tenant_id IS NOT NULL)
      + (SELECT count(*) FROM public.menu_events WHERE tenant_id IS NOT NULL)
    INTO mapped_operational_row_count;

    IF mapped_operational_row_count <> 0 THEN
        RAISE EXCEPTION
            'Operational tenant_id data already exists; this stage seed is no longer rerunnable';
    END IF;

    IF to_regprocedure(
        'ting_private.assign_tenant_id_from_client_slug()'
    ) IS NULL THEN
        RAISE EXCEPTION 'Approved tenant-assignment function is missing';
    END IF;

    -- tgtype = 7 means row-level (1) + BEFORE (2) + INSERT (4), with no
    -- UPDATE, DELETE, or TRUNCATE event bits.
    SELECT count(*)
    INTO assignment_trigger_count
    FROM pg_trigger AS trigger_record
    JOIN pg_class AS table_record
      ON table_record.oid = trigger_record.tgrelid
    JOIN pg_namespace AS schema_record
      ON schema_record.oid = table_record.relnamespace
    WHERE NOT trigger_record.tgisinternal
      AND schema_record.nspname = 'public'
      AND (
          (table_record.relname = 'menu_items'
           AND trigger_record.tgname = 'menu_items_assign_tenant_id')
          OR
          (table_record.relname = 'menu_events'
           AND trigger_record.tgname = 'menu_events_assign_tenant_id')
      )
      AND trigger_record.tgenabled = 'O'
      AND trigger_record.tgtype = 7
      AND trigger_record.tgfoid = to_regprocedure(
          'ting_private.assign_tenant_id_from_client_slug()'
      );

    IF assignment_trigger_count <> 2 THEN
        RAISE EXCEPTION
            'Expected two enabled row-level BEFORE INSERT assignment triggers; found %',
            assignment_trigger_count;
    END IF;
END
$migration$;


-- ============================================================================
-- 2. SEED EXACTLY ONE INTERNAL DEMO TENANT
-- ============================================================================

INSERT INTO public.tenants (client_slug)
VALUES ('the-bistro')
ON CONFLICT (client_slug) DO NOTHING;


-- ============================================================================
-- 3. VERIFY THE CANONICAL ROW AND BOTH EXISTING INSERT MAPPINGS
-- ============================================================================

DO $migration$
DECLARE
    canonical_tenant_id UUID;
    menu_item_probe_id UUID := gen_random_uuid();
    menu_event_probe_id UUID := gen_random_uuid();
    probe_tenant_id UUID;
BEGIN
    SELECT tenant.id
    INTO STRICT canonical_tenant_id
    FROM public.tenants AS tenant
    WHERE tenant.client_slug = 'the-bistro';

    IF canonical_tenant_id IS NULL
       OR (SELECT count(*) FROM public.tenants) <> 1 THEN
        RAISE EXCEPTION
            'Postcondition failed: expected exactly one non-null canonical demo tenant';
    END IF;

    -- Each nested block rolls back only its disposable INSERT. The sentinel is
    -- caught solely when both its SQLSTATE and exact message match.
    BEGIN
        INSERT INTO public.menu_items (
            id,
            client_slug,
            name,
            price
        )
        VALUES (
            menu_item_probe_id,
            'the-bistro',
            'TinG tenant mapping probe',
            0
        )
        RETURNING tenant_id INTO probe_tenant_id;

        IF probe_tenant_id IS DISTINCT FROM canonical_tenant_id THEN
            RAISE EXCEPTION
                'menu_items probe returned %, expected %',
                probe_tenant_id,
                canonical_tenant_id;
        END IF;

        RAISE EXCEPTION 'TING_MENU_ITEM_TENANT_PROBE_ROLLBACK'
            USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM <> 'TING_MENU_ITEM_TENANT_PROBE_ROLLBACK' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.menu_items AS item
        WHERE item.id = menu_item_probe_id
    ) THEN
        RAISE EXCEPTION
            'Rollback-only menu_items probe left residue for id %',
            menu_item_probe_id;
    END IF;

    probe_tenant_id := NULL;

    BEGIN
        INSERT INTO public.menu_events (
            id,
            event_type,
            client_slug,
            metadata
        )
        VALUES (
            menu_event_probe_id,
            'menu_view',
            'the-bistro',
            jsonb_build_object(
                'ting_migration_probe_id',
                menu_event_probe_id::TEXT
            )
        )
        RETURNING tenant_id INTO probe_tenant_id;

        IF probe_tenant_id IS DISTINCT FROM canonical_tenant_id THEN
            RAISE EXCEPTION
                'menu_events probe returned %, expected %',
                probe_tenant_id,
                canonical_tenant_id;
        END IF;

        RAISE EXCEPTION 'TING_MENU_EVENT_TENANT_PROBE_ROLLBACK'
            USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM <> 'TING_MENU_EVENT_TENANT_PROBE_ROLLBACK' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (
        SELECT 1
        FROM public.menu_events AS event
        WHERE event.id = menu_event_probe_id
           OR event.metadata @> jsonb_build_object(
               'ting_migration_probe_id',
               menu_event_probe_id::TEXT
           )
    ) THEN
        RAISE EXCEPTION
            'Rollback-only menu_events probe left residue for id %',
            menu_event_probe_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.tenant_memberships) THEN
        RAISE EXCEPTION
            'Postcondition failed: this migration must not create memberships';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.restaurant_settings WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT 1 FROM public.menu_items WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT 1 FROM public.service_tickets WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT 1 FROM public.table_configurations WHERE tenant_id IS NOT NULL
        UNION ALL
        SELECT 1 FROM public.menu_events WHERE tenant_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'Postcondition failed: historical operational rows were unexpectedly mapped';
    END IF;
END
$migration$;


COMMIT;
