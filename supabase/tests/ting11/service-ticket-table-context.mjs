import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../migrations/20261015010000_ting11_service_ticket_table_context.sql', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../../ting11b-cart.js', import.meta.url), 'utf8');

assert.match(migration, /DROP POLICY IF EXISTS service_tickets_routed_insert ON public\.service_tickets/i);
assert.match(migration, /REVOKE INSERT ON public\.service_tickets FROM PUBLIC, anon, authenticated/i);
assert.match(migration, /CREATE OR REPLACE FUNCTION ting_private\.submit_service_ticket\(/i);
assert.match(migration, /ting_private\.table_access_context_is_valid\(/i);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.submit_service_ticket\(/i);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.submit_service_ticket\(uuid, text, text, text\)\s+TO anon, authenticated/i);
assert.match(migration, /ON CONFLICT \(id\) DO NOTHING/i);

assert.match(client, /rpc\('submit_service_ticket'/);
assert.match(client, /p_table_token:\s*tableAccessToken/);
assert.match(client, /window\.assistanceAvailable\s*=\s*securedAssistanceAvailable/);
assert.match(client, /window\.emitSignalWithRetry\s*=\s*submitServiceTicketWithRetry/);
assert.match(client, /tableAccessToken\s*=\s*hydrateTableAccessToken\(\);[\s\S]*installSecuredAssistanceBridge\(\);/);
assert.match(client, /This table link is not authorized for assistance/);

console.log('PASS: guest assistance uses the issued tenant/table capability and direct anonymous service-ticket inserts are disabled');
