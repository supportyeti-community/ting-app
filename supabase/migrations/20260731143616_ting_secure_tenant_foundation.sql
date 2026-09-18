-- ============================================================================
-- TinG Migration 001 v4: Secure Tenant Foundation
-- ============================================================================
--
-- REVIEW STATUS
--   Complete execution candidate for Claude's final CTO/security review.
--   Nothing in this file has been executed against Supabase.
--
-- VERIFIED PRECONDITIONS (31 July 2026)
--   - public.tenants does not exist.
--   - public.tenant_memberships does not exist.
--   - No public tenant_id columns exist.
--   - ting_private does not exist.
--   - No tenant-related triggers exist.
--   - No tenant-assignment function exists.
--   - Only public and graphql_public are exposed through the Data API.
--   - Migration 001 v1 and v2 were never executed.
--
-- VERIFIED CURRENT SCHEMA
--   client_slug exists on:
--     - public.menu_items
--     - public.menu_events
--
--   client_slug does not exist on:
--     - public.restaurant_settings
--     - public.service_tickets
--     - public.table_configurations
--
-- THIS MIGRATION
--   1. Creates public.tenants.
--   2. Creates public.tenant_memberships.
--   3. Enables RLS immediately on both new public tables.
--   4. Keeps both new tables inaccessible to anon/authenticated roles.
--   5. Adds nullable tenant_id to five existing operational tables.
--   6. Adds tenant foreign keys and indexes.
--   7. Creates a locked internal trigger function.
--   8. Makes the SECURITY DEFINER function owner explicitly postgres.
--   9. Installs triggers only on menu_items and menu_events.
--
-- THIS MIGRATION DOES NOT
--   - Seed tenants.
--   - Backfill existing rows.
--   - Make tenant_id NOT NULL.
--   - Remove or alter client_slug.
--   - Modify existing operational-table RLS policies.
--   - Modify frontend queries or authentication.
--   - Modify Realtime publications or channels.
--   - Guess or fall back to a tenant.
--
-- Until Migration 002 seeds tenants, inserts with an unseeded client_slug
-- safely retain tenant_id = NULL.
-- ============================================================================

BEGIN;


-- ============================================================================
-- 1. CREATE DEDICATED INTERNAL SCHEMA
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ting_private;

-- Make ownership deterministic. If the executing role cannot establish
-- postgres ownership, this statement fails and the transaction rolls back.
ALTER SCHEMA ting_private OWNER TO postgres;

REVOKE ALL ON SCHEMA ting_private FROM PUBLIC;
REVOKE ALL ON SCHEMA ting_private FROM anon;
REVOKE ALL ON SCHEMA ting_private FROM authenticated;


-- ============================================================================
-- 2. CREATE TENANTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_slug TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Ensure client_slug uniqueness if this migration is safely rerun.

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenants'::regclass
          AND conname = 'tenants_client_slug_key'
    ) THEN
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_client_slug_key
            UNIQUE (client_slug);
    END IF;
END
$migration$;


-- ============================================================================
-- 3. CREATE TENANT MEMBERSHIPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 4. SECURE NEW PUBLIC TABLES IMMEDIATELY
-- ============================================================================
--
-- RLS is enabled with no policies. Explicit revocation is also required because
-- table privileges and RLS are separate layers, and Supabase projects may use
-- different default-privilege settings during the 2026 Data API rollout.
-- ============================================================================

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.tenants
    FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.tenant_memberships
    FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 5. ADD TENANT MEMBERSHIP CONSTRAINTS IDEMPOTENTLY
-- ============================================================================

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenant_memberships'::regclass
          AND conname = 'tenant_memberships_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.tenant_memberships
            ADD CONSTRAINT tenant_memberships_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenant_memberships'::regclass
          AND conname = 'tenant_memberships_user_id_fkey'
    ) THEN
        ALTER TABLE public.tenant_memberships
            ADD CONSTRAINT tenant_memberships_user_id_fkey
            FOREIGN KEY (user_id)
            REFERENCES auth.users (id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.tenant_memberships'::regclass
          AND conname = 'tenant_memberships_tenant_user_key'
    ) THEN
        ALTER TABLE public.tenant_memberships
            ADD CONSTRAINT tenant_memberships_tenant_user_key
            UNIQUE (tenant_id, user_id);
    END IF;
END
$migration$;


CREATE INDEX IF NOT EXISTS tenant_memberships_user_id_idx
    ON public.tenant_memberships (user_id);

CREATE INDEX IF NOT EXISTS tenant_memberships_tenant_id_idx
    ON public.tenant_memberships (tenant_id);


-- ============================================================================
-- 6. ADD NULLABLE tenant_id COLUMNS
-- ============================================================================

ALTER TABLE public.restaurant_settings
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

ALTER TABLE public.menu_items
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

ALTER TABLE public.service_tickets
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

ALTER TABLE public.table_configurations
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

ALTER TABLE public.menu_events
    ADD COLUMN IF NOT EXISTS tenant_id UUID;


-- ============================================================================
-- 7. ADD OPERATIONAL-TABLE FOREIGN KEYS IDEMPOTENTLY
-- ============================================================================

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.restaurant_settings'::regclass
          AND conname = 'restaurant_settings_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.restaurant_settings
            ADD CONSTRAINT restaurant_settings_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.menu_items'::regclass
          AND conname = 'menu_items_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.menu_items
            ADD CONSTRAINT menu_items_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.service_tickets'::regclass
          AND conname = 'service_tickets_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.service_tickets
            ADD CONSTRAINT service_tickets_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.table_configurations'::regclass
          AND conname = 'table_configurations_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.table_configurations
            ADD CONSTRAINT table_configurations_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.menu_events'::regclass
          AND conname = 'menu_events_tenant_id_fkey'
    ) THEN
        ALTER TABLE public.menu_events
            ADD CONSTRAINT menu_events_tenant_id_fkey
            FOREIGN KEY (tenant_id)
            REFERENCES public.tenants (id);
    END IF;
END
$migration$;


-- ============================================================================
-- 8. ADD tenant_id INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS restaurant_settings_tenant_id_idx
    ON public.restaurant_settings (tenant_id);

CREATE INDEX IF NOT EXISTS menu_items_tenant_id_idx
    ON public.menu_items (tenant_id);

CREATE INDEX IF NOT EXISTS service_tickets_tenant_id_idx
    ON public.service_tickets (tenant_id);

CREATE INDEX IF NOT EXISTS table_configurations_tenant_id_idx
    ON public.table_configurations (tenant_id);

CREATE INDEX IF NOT EXISTS menu_events_tenant_id_idx
    ON public.menu_events (tenant_id);


-- ============================================================================
-- 9. CREATE LOCKED INTERNAL TENANT-ASSIGNMENT FUNCTION
-- ============================================================================
--
-- SECURITY MODEL
--   - SECURITY DEFINER is narrowly required because existing anonymous insert
--     paths must not receive direct SELECT access to public.tenants.
--   - The function returns TRIGGER, cannot be used as a normal data-returning RPC,
--     and is installed only on the two approved tables.
--   - The function validates its operation, schema, and table at runtime.
--   - It has an empty search_path and fully qualifies every database object.
--   - It lives in an unexposed schema with schema access revoked.
--   - Direct EXECUTE is revoked from public client roles.
--   - Its owner is explicitly changed to postgres and asserted below.
--
-- CONSISTENCY MODEL
--   - If tenant_id is NULL and the slug exists, tenant_id is assigned.
--   - If the slug is not seeded yet, tenant_id remains NULL.
--   - If tenant_id is supplied, it must match client_slug.
--   - A mismatched tenant_id/client_slug pair is rejected.
-- ============================================================================

CREATE OR REPLACE FUNCTION ting_private.assign_tenant_id_from_client_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    resolved_tenant_id UUID;
BEGIN
    IF TG_OP <> 'INSERT'
       OR TG_TABLE_SCHEMA <> 'public'
       OR TG_TABLE_NAME NOT IN ('menu_items', 'menu_events') THEN
        RAISE EXCEPTION
            'assign_tenant_id_from_client_slug may only run for approved INSERT triggers';
    END IF;

    IF NEW.client_slug IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT tenant.id
    INTO resolved_tenant_id
    FROM public.tenants AS tenant
    WHERE tenant.client_slug = NEW.client_slug;

    IF NEW.tenant_id IS NULL THEN
        NEW.tenant_id := resolved_tenant_id;

    ELSIF resolved_tenant_id IS NULL
          OR NEW.tenant_id <> resolved_tenant_id THEN
        RAISE EXCEPTION
            'tenant_id does not match client_slug'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;


-- SECURITY DEFINER runs with the function owner's privileges. Do not rely on
-- whichever role happened to execute CREATE OR REPLACE FUNCTION.
ALTER FUNCTION ting_private.assign_tenant_id_from_client_slug()
    OWNER TO postgres;


-- Fail closed if ownership or SECURITY DEFINER status is not exactly as intended.
DO $migration$
DECLARE
    actual_owner TEXT;
    actual_security_definer BOOLEAN;
BEGIN
    SELECT
        owner_role.rolname,
        proc.prosecdef
    INTO
        actual_owner,
        actual_security_definer
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace
        ON namespace.oid = proc.pronamespace
    JOIN pg_roles AS owner_role
        ON owner_role.oid = proc.proowner
    WHERE namespace.nspname = 'ting_private'
      AND proc.proname = 'assign_tenant_id_from_client_slug'
      AND pg_get_function_identity_arguments(proc.oid) = '';

    IF actual_owner IS DISTINCT FROM 'postgres' THEN
        RAISE EXCEPTION
            'Unexpected owner for ting_private.assign_tenant_id_from_client_slug(): %',
            COALESCE(actual_owner, '<missing>');
    END IF;

    IF actual_security_definer IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION
            'ting_private.assign_tenant_id_from_client_slug() is not SECURITY DEFINER';
    END IF;
END
$migration$;


REVOKE ALL ON FUNCTION
    ting_private.assign_tenant_id_from_client_slug()
    FROM PUBLIC;

REVOKE ALL ON FUNCTION
    ting_private.assign_tenant_id_from_client_slug()
    FROM anon;

REVOKE ALL ON FUNCTION
    ting_private.assign_tenant_id_from_client_slug()
    FROM authenticated;


-- ============================================================================
-- 10. REMOVE UNSAFE OR STALE TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS restaurant_settings_assign_tenant_id
    ON public.restaurant_settings;

DROP TRIGGER IF EXISTS service_tickets_assign_tenant_id
    ON public.service_tickets;

DROP TRIGGER IF EXISTS table_configurations_assign_tenant_id
    ON public.table_configurations;

DROP TRIGGER IF EXISTS menu_items_assign_tenant_id
    ON public.menu_items;

DROP TRIGGER IF EXISTS menu_events_assign_tenant_id
    ON public.menu_events;


-- ============================================================================
-- 11. INSTALL TARGETED INSERT TRIGGERS
-- ============================================================================

CREATE TRIGGER menu_items_assign_tenant_id
BEFORE INSERT ON public.menu_items
FOR EACH ROW
EXECUTE FUNCTION ting_private.assign_tenant_id_from_client_slug();


CREATE TRIGGER menu_events_assign_tenant_id
BEFORE INSERT ON public.menu_events
FOR EACH ROW
EXECUTE FUNCTION ting_private.assign_tenant_id_from_client_slug();


COMMIT;
