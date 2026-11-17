-- Disposable native PostgreSQL 17.6 restore compatibility only.
-- Supabase managed Auth schema has advanced beyond the pinned local image.
-- Based on 2026-11-17 read-only pg_catalog inspection of four production tables.
-- NEVER execute against production; only local Docker container verified by run.sh.
BEGIN;
CREATE TABLE IF NOT EXISTS auth.mfa_recovery_code_sets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  mfa_factor_id uuid NOT NULL UNIQUE REFERENCES auth.mfa_factors(id) ON DELETE CASCADE,
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  verification_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth.mfa_recovery_codes (
  id uuid PRIMARY KEY,
  mfa_recovery_code_set_id uuid NOT NULL REFERENCES auth.mfa_recovery_code_sets(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth.scim_tokens (
  id uuid PRIMARY KEY,
  sso_provider_id uuid NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz CHECK (expires_at IS NULL OR expires_at > created_at),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS auth.scim_users (
  id uuid PRIMARY KEY,
  sso_provider_id uuid NOT NULL REFERENCES auth.sso_providers(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resource jsonb NOT NULL,
  user_name text GENERATED ALWAYS AS (lower(resource ->> 'userName')) STORED NOT NULL,
  external_id text GENERATED ALWAYS AS (resource ->> 'externalId') STORED,
  active boolean GENERATED ALWAYS AS (coalesce((resource ->> 'active')::boolean, true)) STORED NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- Newer hosted Auth has nullable fields absent from pinned native image.
ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS link_token_hash text;
ALTER TABLE auth.saml_providers ADD COLUMN IF NOT EXISTS dedicated_scope boolean;
COMMIT;
