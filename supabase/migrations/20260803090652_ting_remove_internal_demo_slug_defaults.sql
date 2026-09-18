-- ============================================================================
-- TinG: Remove unsafe internal-demo client_slug defaults
-- ============================================================================
--
-- REVIEW STATUS
--   Review-only execution candidate. Nothing in this file has been executed.
--
-- VERIFIED LIVE STATE (2 August 2026, Australia/Adelaide)
--   - public.menu_items.client_slug defaults to 'the-bistro'::text.
--   - public.menu_events.client_slug defaults to 'the-bistro'::text.
--   - No other public column default contains the-bistro.
--   - Both columns are non-null text routing keys.
--   - The existing BEFORE INSERT assignment triggers resolve explicit slugs to
--     the canonical tenant UUID.
--
-- THIS MIGRATION
--   - Drops only the two reviewed the-bistro column defaults.
--   - Keeps both client_slug columns, their NOT NULL constraints, all existing
--     rows, and both tenant-assignment triggers unchanged.
--   - Proves omitted slugs fail closed instead of silently routing to the demo.
--   - Proves explicit the-bistro inserts still resolve to its canonical tenant.
--   - Is safely rerunnable when both defaults are already absent.
--
-- EXECUTION GATE
--   - Application source is not present in this workspace. Before execution,
--     independently verify every menu_items and menu_events insert supplies an
--     explicit client_slug, then perform immediate demo smoke testing.
--
-- THIS MIGRATION DOES NOT
--   - Change tenant_id values or nullability.
--   - Change RLS, grants, policies, functions, triggers, Realtime, Storage,
--     frontend code, routing URLs, or historical data.
-- ============================================================================

-- Fail closed if the two-column routing/default boundary has drifted. Both
-- reviewed defaults may be present (first execution) or absent (clean rerun),
-- but a partial or unexpected default state requires renewed review.
DO $migration$
DECLARE
    menu_items_default TEXT;
    menu_events_default TEXT;
    public_demo_default_count BIGINT;
BEGIN
    IF to_regclass('public.menu_items') IS NULL
       OR to_regclass('public.menu_events') IS NULL
       OR to_regclass('public.tenants') IS NULL THEN
        RAISE EXCEPTION 'Required TinG table is missing';
    END IF;

    IF (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('menu_items', 'menu_events')
          AND column_name = 'client_slug'
          AND data_type = 'text'
          AND is_nullable = 'NO'
    ) <> 2 THEN
        RAISE EXCEPTION 'Expected two non-null text client_slug columns';
    END IF;

    SELECT column_default
    INTO menu_items_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'menu_items'
      AND column_name = 'client_slug';

    SELECT column_default
    INTO menu_events_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'menu_events'
      AND column_name = 'client_slug';

    IF NOT (
        (menu_items_default = '''the-bistro''::text'
         AND menu_events_default = '''the-bistro''::text')
        OR
        (menu_items_default IS NULL AND menu_events_default IS NULL)
    ) THEN
        RAISE EXCEPTION
            'Unexpected or partial client_slug defaults: menu_items %, menu_events %',
            menu_items_default,
            menu_events_default;
    END IF;

    SELECT count(*)
    INTO public_demo_default_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_default ILIKE '%the-bistro%';

    IF public_demo_default_count NOT IN (0, 2) THEN
        RAISE EXCEPTION
            'Unexpected public the-bistro default count: %',
            public_demo_default_count;
    END IF;

    IF public_demo_default_count = 2
       AND (menu_items_default IS NULL OR menu_events_default IS NULL) THEN
        RAISE EXCEPTION 'the-bistro defaults exist outside the reviewed pair';
    END IF;

    IF public_demo_default_count = 0
       AND (menu_items_default IS NOT NULL OR menu_events_default IS NOT NULL) THEN
        RAISE EXCEPTION 'Reviewed client_slug default state is inconsistent';
    END IF;
END;
$migration$;

ALTER TABLE public.menu_items
    ALTER COLUMN client_slug DROP DEFAULT;

ALTER TABLE public.menu_events
    ALTER COLUMN client_slug DROP DEFAULT;

-- Verify the new fail-closed boundary and preserve explicit demo routing. Every
-- disposable insert runs in a nested subtransaction and is rolled back.
DO $migration$
DECLARE
    canonical_tenant_id UUID;
    probe_tenant_id UUID;
    probe_id UUID;
    error_column TEXT;
    error_table TEXT;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('menu_items', 'menu_events')
          AND column_name = 'client_slug'
          AND column_default IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Postcondition failed: a client_slug default remains';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_default ILIKE '%the-bistro%'
    ) THEN
        RAISE EXCEPTION 'Postcondition failed: a public the-bistro default remains';
    END IF;

    SELECT id
    INTO STRICT canonical_tenant_id
    FROM public.tenants
    WHERE client_slug = 'the-bistro';

    -- menu_items must reject an omitted client_slug specifically.
    probe_id := gen_random_uuid();
    BEGIN
        INSERT INTO public.menu_items (id, name, price)
        VALUES (probe_id, 'TinG missing-slug probe', 0);

        RAISE EXCEPTION 'menu_items accepted an omitted client_slug';
    EXCEPTION
        WHEN not_null_violation THEN
            GET STACKED DIAGNOSTICS
                error_column = COLUMN_NAME,
                error_table = TABLE_NAME;
            IF error_column IS DISTINCT FROM 'client_slug'
               OR error_table IS DISTINCT FROM 'menu_items' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.menu_items WHERE id = probe_id) THEN
        RAISE EXCEPTION 'Failed menu_items probe left residue';
    END IF;

    -- menu_events must reject an omitted client_slug specifically.
    probe_id := gen_random_uuid();
    BEGIN
        INSERT INTO public.menu_events (id, event_type, metadata)
        VALUES (
            probe_id,
            'menu_view',
            jsonb_build_object('ting_missing_slug_probe_id', probe_id::text)
        );

        RAISE EXCEPTION 'menu_events accepted an omitted client_slug';
    EXCEPTION
        WHEN not_null_violation THEN
            GET STACKED DIAGNOSTICS
                error_column = COLUMN_NAME,
                error_table = TABLE_NAME;
            IF error_column IS DISTINCT FROM 'client_slug'
               OR error_table IS DISTINCT FROM 'menu_events' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.menu_events WHERE id = probe_id) THEN
        RAISE EXCEPTION 'Failed menu_events probe left residue';
    END IF;

    -- An explicit menu_items slug must still map to the canonical tenant.
    probe_id := gen_random_uuid();
    probe_tenant_id := NULL;
    BEGIN
        INSERT INTO public.menu_items (id, client_slug, name, price)
        VALUES (probe_id, 'the-bistro', 'TinG explicit-slug probe', 0)
        RETURNING tenant_id INTO probe_tenant_id;

        IF probe_tenant_id IS DISTINCT FROM canonical_tenant_id THEN
            RAISE EXCEPTION
                'menu_items explicit-slug probe mapped to %, expected %',
                probe_tenant_id,
                canonical_tenant_id;
        END IF;

        RAISE EXCEPTION 'TING_MENU_ITEM_EXPLICIT_SLUG_PROBE_ROLLBACK'
            USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM <> 'TING_MENU_ITEM_EXPLICIT_SLUG_PROBE_ROLLBACK' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.menu_items WHERE id = probe_id) THEN
        RAISE EXCEPTION 'Explicit menu_items probe left residue';
    END IF;

    -- An explicit menu_events slug must still map to the canonical tenant.
    probe_id := gen_random_uuid();
    probe_tenant_id := NULL;
    BEGIN
        INSERT INTO public.menu_events (id, event_type, client_slug, metadata)
        VALUES (
            probe_id,
            'menu_view',
            'the-bistro',
            jsonb_build_object('ting_explicit_slug_probe_id', probe_id::text)
        )
        RETURNING tenant_id INTO probe_tenant_id;

        IF probe_tenant_id IS DISTINCT FROM canonical_tenant_id THEN
            RAISE EXCEPTION
                'menu_events explicit-slug probe mapped to %, expected %',
                probe_tenant_id,
                canonical_tenant_id;
        END IF;

        RAISE EXCEPTION 'TING_MENU_EVENT_EXPLICIT_SLUG_PROBE_ROLLBACK'
            USING ERRCODE = 'P0001';
    EXCEPTION
        WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM <> 'TING_MENU_EVENT_EXPLICIT_SLUG_PROBE_ROLLBACK' THEN
                RAISE;
            END IF;
    END;

    IF EXISTS (SELECT 1 FROM public.menu_events WHERE id = probe_id) THEN
        RAISE EXCEPTION 'Explicit menu_events probe left residue';
    END IF;
END;
$migration$;
