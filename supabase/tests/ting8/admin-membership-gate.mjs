import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const admin = readFileSync(new URL('../../../admin.html', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../migrations/20260925093356_ting8_admin_membership_gate.sql', import.meta.url), 'utf8');

const rpcCall = "supabaseInstance.rpc('can_manage_current_tenant')";
const gateIndex = admin.indexOf(rpcCall);
const renderIndex = admin.indexOf('renderMainWorkspaceShellMarkup();', gateIndex);

assert(gateIndex >= 0, 'admin must call can_manage_current_tenant');
assert(renderIndex > gateIndex, 'membership gate must run before workspace render');
assert(admin.includes('if (membershipError || canManageTenant !== true)'), 'admin must fail closed on RPC error or false');
assert(admin.includes('renderTenantAccessDenied();'), 'admin must render an access-denied state');
assert(admin.includes('This account is not authorized to manage this restaurant.'), 'access-denied copy missing');

assert(migration.includes('CREATE OR REPLACE FUNCTION public.can_manage_current_tenant()'), 'migration must create the RPC');
assert(migration.includes('SECURITY INVOKER'), 'RPC must remain security-invoker');
assert(migration.includes('ting_private.can_manage_tenant(ting_private.request_tenant_id())'), 'RPC must compose routed tenant + membership helpers');
assert(migration.includes('REVOKE ALL ON FUNCTION public.can_manage_current_tenant()'), 'RPC grants must start fail-closed');
assert(migration.includes('GRANT EXECUTE ON FUNCTION public.can_manage_current_tenant()\n  TO authenticated;'), 'only authenticated clients may execute the RPC');

console.log('PASS: TING-8 admin membership gate is fail-closed and exposes only a routed boolean');
