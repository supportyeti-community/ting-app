import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const customer=readFileSync(new URL('../../../index.html',import.meta.url),'utf8');
const admin=readFileSync(new URL('../../../admin.html',import.meta.url),'utf8');

const telemetry=customer.slice(customer.indexOf('async function logTelemetryAnalyticsEvent'),customer.indexOf('</script>',customer.indexOf('async function logTelemetryAnalyticsEvent')));
assert.match(telemetry,/if \(!supabaseInstance \|\| !tenantId\) return/);
assert.match(telemetry,/tenant_id:\s*tenantId/);
assert.match(telemetry,/client_slug:\s*clientSlug/);

const analytics=admin.slice(admin.indexOf('async function refreshLiveAnalyticsMetrics'),admin.indexOf('function ',admin.indexOf('async function refreshLiveAnalyticsMetrics')+20));
const chains=[];
for(const match of analytics.matchAll(/\.from\(['"]menu_events['"]\)/g)) {
 const end=analytics.indexOf(';',match.index);
 chains.push(analytics.slice(match.index,end<0?match.index+800:end));
}
assert.equal(chains.length,3,'admin analytics must retain all three queries');
for(const chain of chains) assert.match(chain,/\.eq\(['"]tenant_id['"],\s*tenantId\)/);

console.log('PASS: analytics frontend writes explicit ownership and scopes every staff query by tenant UUID');
