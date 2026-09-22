// Executes the shipped inline JavaScript with controlled DOM/network substitutes.
// These are behavior tests, not browser rendering or live CDN verification.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
for(const file of ['index.html','admin.html']) {
 const html=readFileSync(new URL('../../../'+file,import.meta.url),'utf8');
 const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join('\n');
 new vm.Script(code);
 const boot=file==='index.html'?'executeSecureClientBootloader':'executeSecurePlatformBootloader';
 for(const scenario of ['missing','unknown','rpc-error','no-table','valid']) {
  const calls=[],nodes=new Map();let creations=0;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='mergeSource'?'1':'2',style:{},classList:{add(){},remove(){}},appendChild(){},addEventListener(){}});return nodes.get(id);};
  const builder=table=>{
   const ops=[];
   const b=new Proxy({}, {get(_,key){if(key==='then')return(resolve)=>resolve(table==='restaurant_clients'?{data:scenario==='unknown'?null:{supabase_url:'http://127.0.0.1:54321',supabase_anon_key:'synthetic'},error:null}:{data:table==='restaurant_settings'?null:[],error:null});return(...args)=>{ops.push([key,...args]);calls.push({table,key,args});return b;};}});return b;
  };
  const client={from:builder,rpc:async name=>{calls.push({rpc:name});return {data:scenario==='rpc-error'?null:'tenant-a',error:scenario==='rpc-error'?{}:null};},channel:()=>({on(){return this;},subscribe(){return this;}})};
  const context=vm.createContext({URLSearchParams,window:{location:{search:scenario==='missing'?'':scenario==='no-table'?'?client=test-a':'?client=test-a&table=1'}},document:{getElementById:node,createElement:()=>node('temporary'),createTextNode:s=>s},supabase:{createClient:(url,key,options)=>{calls.push({options});creations++;return client;}},console:{error(){}},setTimeout:()=>1,setInterval:()=>1,clearInterval(){},alert:()=>{throw new Error('Unexpected alert');}});
  vm.runInContext(code.replace(new RegExp('    '+boot+'\\(\\);'),''),context);
  vm.runInContext('initAdminAuth=async()=>{}; loadLiveMenuFromDatabase=async()=>{};',context);
  await vm.runInContext(boot+'()',context);
  if(file==='index.html') {
   const before=calls.length;
   const ready=await vm.runInContext("emitSignalWithRetry('test request','synthetic-id')",context);
   assert.equal(ready,scenario==='valid');
   const writes=calls.slice(before).filter(c=>c.table==='service_tickets'&&c.key==='insert');
   assert.equal(writes.length,scenario==='valid'?1:0);
   if(scenario!=='valid') {
    assert.equal(node('toastHub').style.display,'block');
    assert.match(node('toastHub').innerText,/QR code|connection unavailable/);
    vm.runInContext('toggleModal(true)',context);
    assert.notEqual(node('pagerModal').style.display,'flex');
   } else {
    assert.equal(writes[0].args[0][0].table_number,'1');
    assert.equal(writes[0].args[0][0].client_slug,'test-a');
   }
  }
  if(scenario==='missing'){assert.equal(creations,0);continue;}
  if(scenario==='unknown'){assert.equal(creations,1);continue;}
  assert.equal(creations,2);assert.equal(calls[1]?.options,undefined); // routing query recorded between clients
  assert(calls.some(c=>c.options?.global?.headers['x-client-slug']==='test-a'));
  if(scenario==='rpc-error'){assert.equal(vm.runInContext('tenantId',context),null);continue;}
  assert.equal(vm.runInContext('tenantId',context),'tenant-a');
  if(file==='admin.html') {
   vm.runInContext('syncServiceTicketsFromCloudDb=async()=>{}; renderActiveMergesUI=()=>{};',context);
   await vm.runInContext('executeUiTableMerge()',context);
   const upsert=calls.find(c=>c.table==='table_configurations'&&c.key==='upsert');
   assert.equal(upsert.args[0][0].tenant_id,'tenant-a');assert.equal(upsert.args[1].onConflict,'tenant_id,source_table,target_table');
   assert(calls.some(c=>c.table==='table_configurations'&&c.key==='eq'&&c.args[0]==='tenant_id'&&c.args[1]==='tenant-a'));
  } else assert(calls.some(c=>c.table==='restaurant_settings'&&c.key==='eq'&&c.args[0]==='tenant_id'&&c.args[1]==='tenant-a'));
 }
 console.log('PASS: '+file+' syntax, missing/unknown tenant, resolver failure and scoped requests');
}
