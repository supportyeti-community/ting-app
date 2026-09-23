import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {A,B,U,V,G} from './verify.mjs';

export const eventMigrationName='20260922155033_ting2_menu_event_isolation.sql';
export const eventMigration=readFileSync(new URL('../../migrations/'+eventMigrationName,import.meta.url),'utf8');

export async function verifyMenuEvents(db,pass,apply=()=>db.query(eventMigration)) {
 const q=(sql,params)=>db.query(sql,params);
 const as=async(role,user,headers,sql)=>{
  await q('BEGIN');
  try {
   await q(`SET LOCAL ROLE ${role}`);
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.headers',$3,true)",[user||'',JSON.stringify({sub:user,role,user_metadata:{tenant_id:B,role:'owner'}}),headers]);
   return await q(sql);
  } finally {await q('ROLLBACK');}
 };
 const denied=async fn=>{let error;try{await fn();}catch(e){error=e;}assert(error&&['42501','23514','23502'].includes(error.code),'Expected analytics authorization/ownership rejection');};

 await q('DELETE FROM public.menu_events');
 await q(`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES
 ('${A}','test-a','Analytics A',1),('${B}','test-b','Analytics B',1)`);
 const items=(await q("SELECT id,tenant_id FROM public.menu_items WHERE name LIKE 'Analytics %' ORDER BY tenant_id")).rows;
 const itemA=items.find(row=>row.tenant_id===A).id;
 const itemB=items.find(row=>row.tenant_id===B).id;
 await q(`INSERT INTO public.menu_events(tenant_id,client_slug,event_type,item_id) VALUES
 ('${A}','test-a','menu_view','${itemA}'),('${B}','test-b','item_viewed','${itemB}')`);
 assert.equal((await as('authenticated',G,'{}','SELECT id FROM public.menu_events')).rows.length,2);
 await as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_events(client_slug,event_type) VALUES ('test-b','menu_view')`);
 pass('Live baseline reproduced: global-admin analytics read and route-unbound public insert');
 await q("DELETE FROM public.menu_events WHERE metadata = '{}'::jsonb AND item_id IS NULL");

 await q("INSERT INTO public.menu_events(client_slug,event_type) VALUES ('missing-tenant','menu_view')");
 try {await q(eventMigration);assert.fail('Unowned analytics migration accepted');}
 catch(e){await q('ROLLBACK');assert.match(e.message,/explicit, matching tenant and item ownership/);}
 await q("DELETE FROM public.menu_events WHERE client_slug='missing-tenant'");
 await q(`INSERT INTO public.menu_events(tenant_id,client_slug,event_type,item_id) VALUES ('${A}','test-a','item_viewed','${itemB}')`);
 try {await q(eventMigration);assert.fail('Cross-tenant item reference accepted');}
 catch(e){await q('ROLLBACK');assert.match(e.message,/explicit, matching tenant and item ownership/);}
 await q(`DELETE FROM public.menu_events WHERE tenant_id='${A}' AND item_id='${itemB}'`);
 await apply();

 for(const headers of ['{}','','not-json','{"x-client-slug":"unknown"}','{"x-client-slug":"test-b"}'])
  await denied(()=>as('anon',null,headers,`INSERT INTO public.menu_events(tenant_id,client_slug,event_type) VALUES ('${A}','test-a','menu_view')`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_events(tenant_id,client_slug,event_type) VALUES ('${B}','test-a','menu_view')`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_events(tenant_id,client_slug,event_type) VALUES ('${A}','test-b','menu_view')`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_events(tenant_id,client_slug,event_type,item_id) VALUES ('${A}','test-a','item_viewed','${itemB}')`));
 await as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_events(tenant_id,client_slug,event_type,item_id) VALUES ('${A}','test-a','item_viewed','${itemA}')`);
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}','SELECT id FROM public.menu_events'));

 for(const [user,own,other] of [[U,A,B],[V,B,A]]) {
  const rows=(await as('authenticated',user,'{}','SELECT tenant_id FROM public.menu_events')).rows;
  assert(rows.length>0 && rows.every(row=>row.tenant_id===own));
  assert.equal((await as('authenticated',user,'{}',`DELETE FROM public.menu_events WHERE tenant_id='${other}' RETURNING id`)).rows.length,0);
  await denied(()=>as('authenticated',user,'{}',`UPDATE public.menu_events SET table_number='99' WHERE tenant_id='${own}'`));
 }
 assert.equal((await as('authenticated',G,'{"x-client-slug":"test-b"}','SELECT id FROM public.menu_events')).rows.length,0);
 await denied(()=>as('authenticated',G,'{}','TRUNCATE public.menu_events'));
 await q(`UPDATE public.tenant_memberships SET role='viewer' WHERE user_id='${U}'`);
 assert.equal((await as('authenticated',U,'{}',`DELETE FROM public.menu_events WHERE tenant_id='${A}' RETURNING id`)).rows.length,0);
 assert.equal((await as('authenticated',U,'{}','SELECT id FROM public.menu_events')).rows.length,0);
 await q(`UPDATE public.tenant_memberships SET role='owner' WHERE user_id='${U}'`);
 assert.equal((await q("SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='menu_events'")).rows[0].n,0);
 pass('Menu events: route-bound inserts, same-tenant item references, member read/delete, append-only grants, global-admin denial and immediate revocation');
}
