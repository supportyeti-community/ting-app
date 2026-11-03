import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(
  new URL('../../migrations/20261031113000_ting11_cap1_table_capability_lifecycle.sql', import.meta.url),
  'utf8'
);

const compact = sql.replace(/\s+/g, ' ');

assert.match(compact, /CREATE OR REPLACE FUNCTION ting_private\.revoke_table_access_context\(p_context_id uuid\)/i);
assert.match(compact, /CREATE OR REPLACE FUNCTION public\.revoke_table_access_context\(p_context_id uuid\)/i);
assert.match(compact, /CREATE OR REPLACE FUNCTION ting_private\.rotate_table_access_context\(p_table_number text\)/i);
assert.match(compact, /CREATE OR REPLACE FUNCTION public\.rotate_table_access_context\(p_table_number text\)/i);

for (const fn of ['revoke_table_access_context', 'rotate_table_access_context']) {
  const privateStart = compact.indexOf(`CREATE OR REPLACE FUNCTION ting_private.${fn}`);
  assert.notEqual(privateStart, -1, `missing private ${fn}`);
  const nextFunction = compact.indexOf('CREATE OR REPLACE FUNCTION', privateStart + 1);
  const body = compact.slice(privateStart, nextFunction === -1 ? compact.length : nextFunction);
  assert.match(body, /ting_private\.request_tenant_id\(\)/i, `${fn} must bind to routed tenant`);
  assert.match(body, /auth\.uid\(\)/i, `${fn} must require a signed-in actor`);
  assert.match(body, /ting_private\.can_manage_tenant\(routed_tenant_id\)/i, `${fn} must require tenant management authority`);
  assert.match(body, /SECURITY DEFINER/i, `${fn} private implementation must be security definer`);
  assert.match(body, /SET search_path = ''/i, `${fn} must use an empty search_path`);
}

assert.match(compact, /UPDATE public\.table_access_contexts AS context SET revoked_at = COALESCE\(context\.revoked_at, pg_catalog\.clock_timestamp\(\)\) WHERE context\.id = p_context_id AND context\.tenant_id = routed_tenant_id/i,
  'specific revocation must be tenant-bound and retry-safe');

assert.match(compact, /pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\(routed_tenant_id::text \|\| ':' \|\| normalized_table, 0\)\s*\)/i,
  'rotation must serialize concurrent replacements for the same tenant/table');
assert.match(compact, /UPDATE public\.table_access_contexts AS context SET revoked_at = pg_catalog\.clock_timestamp\(\) WHERE context\.tenant_id = routed_tenant_id AND context\.table_number = normalized_table AND context\.revoked_at IS NULL/i,
  'rotation must revoke only active contexts for the routed tenant/table');
assert.match(compact, /extensions\.gen_random_bytes\(32\)/i, 'replacement token must retain 256-bit randomness');
assert.match(compact, /extensions\.digest\(raw_token, 'sha256'\)/i, 'replacement token must remain hash-only at rest');

for (const signature of [
  'public.revoke_table_access_context(uuid)',
  'public.rotate_table_access_context(text)'
]) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(compact, new RegExp(`REVOKE ALL ON FUNCTION ${escaped} FROM PUBLIC, anon, authenticated, service_role`, 'i'));
  assert.match(compact, new RegExp(`GRANT EXECUTE ON FUNCTION ${escaped} TO authenticated`, 'i'));
}

assert.doesNotMatch(compact, /GRANT EXECUTE ON FUNCTION public\.(?:revoke|rotate)_table_access_context[^;]*TO anon/i,
  'anonymous callers must never receive table-capability lifecycle authority');
assert.doesNotMatch(compact, /GRANT EXECUTE ON FUNCTION public\.(?:revoke|rotate)_table_access_context[^;]*TO service_role/i,
  'service role must not receive the public staff lifecycle surface');

console.log('PASS: CAP-1 table capability revoke/rotation contract');
