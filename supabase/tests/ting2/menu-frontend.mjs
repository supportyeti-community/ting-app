import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const customer=readFileSync(new URL('../../../index.html',import.meta.url),'utf8');
const admin=readFileSync(new URL('../../../admin.html',import.meta.url),'utf8');

for(const [name,html] of [['customer',customer],['admin',admin]]) {
  assert(!/table:\s*['"]menu_items['"]/.test(html),`${name} must not subscribe to unfilterable menu DELETE events`);
  const chains=[];
  for(const match of html.matchAll(/\.from\(['"]menu_items['"]\)/g)) {
    const end=html.indexOf(';',match.index);
    chains.push(html.slice(match.index,end<0?match.index+800:end));
  }
  assert(chains.length>0,`${name} must access menu_items`);
  for(const chain of chains) {
    if(chain.includes('.insert(')) assert.match(chain,/tenant_id:\s*tenantId/);
    else assert.match(chain,/\.eq\(['"]tenant_id['"],\s*tenantId\)/);
  }
}

assert.match(customer,/menuPoll\s*=\s*setInterval\(loadLiveMenuFromDatabase,\s*10000\)/);
assert.match(admin,/setInterval\(async \(\) => \{[\s\S]*?loadLiveMenuFromDatabase\(\);[\s\S]*?\}, 10000\)/);
console.log('PASS: menu frontends scope every read/write to tenant ownership and poll without menu Realtime');
