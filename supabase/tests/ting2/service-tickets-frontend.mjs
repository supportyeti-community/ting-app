import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const customer=readFileSync(new URL('../../../index.html',import.meta.url),'utf8');
const admin=readFileSync(new URL('../../../admin.html',import.meta.url),'utf8');

const ticketInsert=customer.slice(customer.indexOf('async function emitSignalWithRetry'),customer.indexOf('async function emitSignal',customer.indexOf('async function emitSignalWithRetry')+20));
assert.match(ticketInsert,/client_slug:\s*clientSlug/);

const realtime=admin.slice(admin.indexOf("supabaseInstance.channel('dashboard-realtime-mutations')"),admin.indexOf('loadLiveMenuFromDatabase()',admin.indexOf("supabaseInstance.channel('dashboard-realtime-mutations')")));
assert.match(realtime,/event:\s*'INSERT'/);
assert.match(realtime,/event:\s*'UPDATE'/);
assert.match(realtime,/filter:\s*`tenant_id=eq\.\$\{tenantId\}`/);
assert.doesNotMatch(realtime,/event:\s*'\*'/);
assert.doesNotMatch(realtime,/event:\s*'DELETE'/);

const sync=admin.slice(admin.indexOf('async function syncServiceTicketsFromCloudDb'),admin.indexOf('function ',admin.indexOf('async function syncServiceTicketsFromCloudDb')+20));
assert.match(sync,/\.eq\('tenant_id',\s*tenantId\)/);
const resolve=admin.slice(admin.indexOf('async function clearUnifiedTicketsGroup'),admin.indexOf('function ',admin.indexOf('async function clearUnifiedTicketsGroup')+20));
assert.match(resolve,/\.eq\('tenant_id',\s*tenantId\)/);

console.log('PASS: ticket frontend keeps routed inserts, tenant-scoped reads/updates and filtered INSERT/UPDATE Realtime only');
