import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { historicalFiles } from './history.mjs';

const A='10000000-0000-4000-8000-000000000011', B='10000000-0000-4000-8000-000000000012';
const ITEM_A='30000000-0000-4000-8000-000000000011', ITEM_PROMO='30000000-0000-4000-8000-000000000012';
const ITEM_OUT='30000000-0000-4000-8000-000000000013', ITEM_B='30000000-0000-4000-8000-000000000014';
const BISTRO='d8e68393-70de-4e77-8c07-51992f2b64a6';
const ROUTE_SCOPE='20260923132307_ting2_route_scope_registry.sql';
const MEMBER_SCOPE='20260925013625_ting4_scope_menu_picture_writes.sql';
const releaseFiles=[
 '20260918144301_ting2_settings_table_isolation.sql','20260922054639_ting2_menu_item_isolation.sql',
 '20260922155033_ting2_menu_event_isolation.sql','20260923101432_ting2_service_ticket_authorization.sql',
 '20260923113515_ting2_routing_registry_prepare.sql',ROUTE_SCOPE,
 '20260923200127_ting4_restrict_menu_picture_listing.sql',MEMBER_SCOPE,
 '20260925093356_ting8_admin_membership_gate.sql','20260930030209_ting6_harden_sanitize_text_search_path.sql',
 '20261008074200_ting11_ordering_foundation.sql','20261008075500_ting11_order_item_tenant_coupling.sql'
];
const sourceSql=name=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');

export async function rehearseTing11(db,status,report,command,workdir){
 const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};
 const directory=join(workdir,'supabase/migrations');mkdirSync(directory,{recursive:true});
 const history=historicalFiles();
 for(const f of history)writeFileSync(join(directory,f.filename),f.sql);
 command(['migration','repair',...history.map(r=>r.version),'--local','--status','applied']);
 for(const f of history)await db.query('UPDATE supabase_migrations.schema_migrations SET name=$2,statements=$3 WHERE version=$1',[f.version,f.name,[f.sql]]);
 const ledger=async()=>(await db.query('SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
 let current=await ledger();
 for(const name of releaseFiles){
  if(name===ROUTE_SCOPE){
   const n=(await db.query("SELECT count(*)::int AS n FROM public.restaurant_clients WHERE client_slug='the-bistro'")).rows[0].n;
   if(n===0)await db.query("INSERT INTO public.restaurant_clients(client_slug,supabase_url,supabase_anon_key,restaurant_name) VALUES ('the-bistro','http://127.0.0.1:54321','local-public-key','Bistro')");
  }
  if(name===MEMBER_SCOPE){
   const n=(await db.query('SELECT count(*)::int AS n FROM public.tenants WHERE id=$1',[BISTRO])).rows[0].n;
   if(n===0)await db.query("INSERT INTO public.tenants(id,client_slug) VALUES ($1,'the-bistro')",[BISTRO]);
  }
  writeFileSync(join(directory,name),sourceSql(name));
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),current,'dry-run changed history before '+name);
  try{command(['db','push','--local','--skip-vault','--yes']);}catch{throw new Error('Release migration failed: '+name);}
  const applied=await ledger();assert.equal(applied.length,current.length+1,'unexpected ledger growth after '+name);
  assert.equal(applied.at(-1).version,name.split('_')[0],'wrong migration recorded for '+name);current=applied;
 }
 command(['db','push','--local','--skip-vault','--yes']);assert.deepEqual(await ledger(),current,'second release push was not a no-op');
 pass('Current release chain + TING-11 migrations dry-run/apply individually and repeated no-op');

 await db.query("INSERT INTO public.tenants(id,client_slug) VALUES ($1,'order-a'),($2,'order-b')",[A,B]);
 await db.query(`INSERT INTO public.menu_items(id,tenant_id,client_slug,name,price,is_promo,promo_price,is_out_of_stock,sort_order) VALUES
 ($1,$5,'order-a','Authoritative A',12.50,false,NULL,false,1),
 ($2,$5,'order-a','Promo A',10.00,true,8.00,false,2),
 ($3,$5,'order-a','Out A',4.00,false,NULL,true,3),
 ($4,$6,'order-b','Foreign B',6.00,false,NULL,false,1)`,[ITEM_A,ITEM_PROMO,ITEM_OUT,ITEM_B,A,B]);
 const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const service=createClient(status.API_URL,status.SERVICE_ROLE_KEY,options);
 const client=(slug)=>createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':slug}}});
 const visitorA=client('order-a'), visitorB=client('order-b'), adminA=client('order-b');
 const ok=(r,label)=>{assert(!r.error,label+': '+(r.error?.code||'unknown'));return r.data;};
 const denied=async(p,label)=>{const r=await p;assert(r.error,label+' unexpectedly succeeded');return r.error;};
 const row=d=>Array.isArray(d)?d[0]:d;
 try{
  let ready=false;for(let i=0;i<30;i++){const r=await visitorA.rpc('submit_order',{p_table_number:'1',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_OUT,quantity:1}]});if(!r.error||!String(r.error.code||'').startsWith('PGRST')){ready=true;break;}await new Promise(x=>setTimeout(x,500));}assert(ready,'PostgREST TING-11 RPC cache not ready');
  assert((await visitorA.from('orders').insert({tenant_id:A,table_number:'1',status:'submitted',subtotal:0,total:0,client_request_id:randomUUID()})).error);
  assert((await visitorA.from('order_items').insert({tenant_id:A,order_id:randomUUID(),menu_item_id:ITEM_A,item_name_snapshot:'x',unit_price_snapshot:1,quantity:1,line_total:1})).error);
  assert((await visitorA.from('orders').select('id')).error);pass('Anon direct order tables are denied; customer ordering is RPC-only');

  const requestId=randomUUID();
  const submitted=row(ok(await visitorA.rpc('submit_order',{p_table_number:' 12 ',p_client_request_id:requestId,p_items:[{menu_item_id:ITEM_A,quantity:2,price:.01,total:.02,tenant_id:B,name:'forged'},{menu_item_id:ITEM_PROMO,quantity:1,price:.01}]}),'submit routed order'));
  const stored=(await db.query('SELECT tenant_id,table_number,status,subtotal,total FROM public.orders WHERE id=$1',[submitted.id])).rows[0];
  assert.equal(stored.tenant_id,A);assert.equal(stored.table_number,'12');assert.equal(stored.status,'submitted');assert.equal(Number(stored.total),33);
  const lines=(await db.query('SELECT menu_item_id,item_name_snapshot,unit_price_snapshot,quantity,line_total FROM public.order_items WHERE order_id=$1',[submitted.id])).rows;
  const regular=lines.find(x=>x.menu_item_id===ITEM_A), promo=lines.find(x=>x.menu_item_id===ITEM_PROMO);
  assert.equal(lines.length,2);assert.equal(regular.item_name_snapshot,'Authoritative A');assert.equal(Number(regular.unit_price_snapshot),12.5);assert.equal(regular.quantity,2);assert.equal(Number(regular.line_total),25);assert.equal(Number(promo.unit_price_snapshot),8);assert.equal(Number(promo.line_total),8);
  pass('Route owns tenant; forged customer pricing/name/tenant fields are ignored and authoritative snapshots persist');

  const retried=row(ok(await visitorA.rpc('submit_order',{p_table_number:'99',p_client_request_id:requestId,p_items:[{menu_item_id:ITEM_A,quantity:1}]}),'retry'));
  assert.equal(retried.id,submitted.id);assert.equal((await db.query('SELECT count(*)::int n FROM public.orders WHERE tenant_id=$1 AND client_request_id=$2',[A,requestId])).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM public.order_items WHERE order_id=$1',[submitted.id])).rows[0].n,2);pass('Idempotent retry returns original order without duplicates');

  await denied(visitorA.rpc('submit_order',{p_table_number:'12',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_B,quantity:1}]}),'cross-tenant item');
  await denied(visitorA.rpc('submit_order',{p_table_number:'12',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_OUT,quantity:1}]}),'out-of-stock item');
  await denied(visitorA.rpc('submit_order',{p_table_number:'bad!',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_A,quantity:1}]}),'bad table');pass('Cross-tenant, out-of-stock, and malformed-table submissions fail closed');

  const bOrder=row(ok(await visitorB.rpc('submit_order',{p_table_number:'2',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_B,quantity:1}]}),'tenant B order'));
  let fk=false;try{await db.query("INSERT INTO public.order_items(tenant_id,order_id,menu_item_id,item_name_snapshot,unit_price_snapshot,quantity,line_total) VALUES ($1,$2,$3,'cross',6,1,6)",[B,submitted.id,ITEM_B]);}catch(e){fk=e.code==='23503';}assert(fk);pass('Composite parent-order FK blocks cross-tenant child drift');

  await denied(visitorA.rpc('advance_order_status',{p_order_id:submitted.id,p_next_status:'accepted'}),'anon advance');
  const email='ting11-'+randomUUID()+'@example.com',password=randomUUID()+'Aa1!';const user=ok(await service.auth.admin.createUser({email,password,email_confirm:true}),'create admin').user;
  await db.query('INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)',[A,user.id,'owner']);ok(await adminA.auth.signInWithPassword({email,password}),'admin login');
  const visible=ok(await adminA.from('orders').select('id,tenant_id'),'member read');assert(visible.length>=1&&visible.every(x=>x.tenant_id===A)&&!visible.some(x=>x.id===bOrder.id));pass('Membership, not routed slug, controls order visibility');
  await denied(adminA.rpc('advance_order_status',{p_order_id:submitted.id,p_next_status:'ready'}),'invalid jump');for(const next of ['accepted','preparing','ready','completed'])assert.equal(row(ok(await adminA.rpc('advance_order_status',{p_order_id:submitted.id,p_next_status:next}),'advance '+next)).status,next);await denied(adminA.rpc('advance_order_status',{p_order_id:submitted.id,p_next_status:'accepted'}),'reverse completed');pass('Only submitted -> accepted -> preparing -> ready -> completed is allowed');
  const revoke=row(ok(await visitorA.rpc('submit_order',{p_table_number:'8',p_client_request_id:randomUUID(),p_items:[{menu_item_id:ITEM_A,quantity:1}]}),'revocation order'));await db.query('DELETE FROM public.tenant_memberships WHERE user_id=$1',[user.id]);assert.equal(ok(await adminA.from('orders').select('id'),'revoked read').length,0);await denied(adminA.rpc('advance_order_status',{p_order_id:revoke.id,p_next_status:'accepted'}),'revoked advance');pass('Membership revocation immediately removes order visibility and lifecycle authority');
 }finally{await Promise.allSettled([service.removeAllChannels(),visitorA.removeAllChannels(),visitorB.removeAllChannels(),adminA.removeAllChannels()]);}
}
