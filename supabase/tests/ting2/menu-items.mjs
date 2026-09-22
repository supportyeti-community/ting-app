import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {A,B,U,V,G} from './verify.mjs';
export const menuMigrationName='20260922054639_ting2_menu_item_isolation.sql';
export const menuMigration=readFileSync(new URL('../../migrations/'+menuMigrationName,import.meta.url),'utf8');

export async function verifyMenuItems(db,pass,apply=()=>db.query(menuMigration)) {
 const q=(sql,params)=>db.query(sql,params);
 const as=async(role,user,headers,sql)=>{
  await q('BEGIN');
  try {
   await q(`SET LOCAL ROLE ${role}`);
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.headers',$3,true)",[user||'',JSON.stringify({sub:user,role,user_metadata:{tenant_id:B,role:'owner'}}),headers]);
   return await q(sql);
  } finally {await q('ROLLBACK');}
 };
 const denied=async fn=>{let error;try{await fn();}catch(e){error=e;}assert(error&&['42501','23514','23502'].includes(error.code),'Expected menu authorization/ownership rejection');};
 // The native baseline includes a real seed menu row. This disposable test owns
 // the table from here so its row-count assertions remain deterministic.
 await q('DELETE FROM public.menu_items');
 await q(`INSERT INTO public.menu_items(tenant_id,client_slug,name,price,sort_order) VALUES
 ('${A}','test-a','A item',10,0),('${B}','test-b','B item',12,0)`);
 assert.equal((await as('anon',null,'{}','SELECT id FROM public.menu_items')).rows.length,2);
 assert.equal((await as('anon',null,'{"x-client-slug":"unknown"}','SELECT id FROM public.menu_items')).rows.length,2);
 await as('authenticated',G,'{}',`UPDATE public.menu_items SET name='global gap' WHERE tenant_id='${B}'`);
 pass('Live baseline reproduced: unrouted public menu and global-admin foreign write');

 await q("INSERT INTO public.menu_items(client_slug,name,price) VALUES ('missing-tenant','unowned',1)");
 try {await q(menuMigration);assert.fail('Unowned menu migration accepted');}
 catch(e){await q('ROLLBACK');assert.match(e.message,/explicit, matching tenant ownership/);}
 await q("DELETE FROM public.menu_items WHERE client_slug='missing-tenant'");
 await apply();

 for(const headers of ['{}','','not-json','{"x-client-slug":"unknown"}'])
  assert.equal((await as('anon',null,headers,'SELECT id FROM public.menu_items')).rows.length,0);
 assert.deepEqual((await as('anon',null,'{"x-client-slug":"test-a"}','SELECT tenant_id FROM public.menu_items')).rows,[{tenant_id:A}]);
 assert.deepEqual((await as('anon',null,'{"x-client-slug":"test-b"}','SELECT tenant_id FROM public.menu_items')).rows,[{tenant_id:B}]);
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES ('${A}','test-a','denied',1)`));

 for(const [user,own,slug,other] of [[U,A,'test-a',B],[V,B,'test-b',A]]) {
  assert.deepEqual((await as('authenticated',user,'{}','SELECT tenant_id FROM public.menu_items')).rows,[{tenant_id:own}]);
  assert.equal((await as('authenticated',user,'{}',`UPDATE public.menu_items SET name='own edit' WHERE tenant_id='${own}' RETURNING id`)).rows.length,1);
  assert.equal((await as('authenticated',user,'{}',`DELETE FROM public.menu_items WHERE tenant_id='${other}' RETURNING id`)).rows.length,0);
  await denied(()=>as('authenticated',user,'{}',`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES ('${other}','${slug}','foreign',1)`));
  await denied(()=>as('authenticated',user,'{}',`UPDATE public.menu_items SET tenant_id='${other}' WHERE tenant_id='${own}'`));
  await denied(()=>as('authenticated',user,'{}',`UPDATE public.menu_items SET client_slug='changed' WHERE tenant_id='${own}'`));
 }
 await as('authenticated',U,'{}',`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES ('${A}','test-a','new own',2)`);
 await denied(()=>as('authenticated',U,'{}',`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES ('${A}','test-b','mismatch',2)`));
 await denied(()=>as('authenticated',U,'{}',`INSERT INTO public.menu_items(tenant_id,client_slug,name,price) VALUES ('${A}','test-a','negative',-1)`));
 assert.equal((await as('authenticated',G,'{"x-client-slug":"test-b"}',`UPDATE public.menu_items SET name='forged' WHERE tenant_id='${B}' RETURNING id`)).rows.length,0);
 await denied(()=>as('authenticated',G,'{}','TRUNCATE public.menu_items'));
 assert.equal((await q("SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='menu_items'")).rows[0].n,0);
 await q(`UPDATE public.tenant_memberships SET role='viewer' WHERE user_id='${U}'`);
 assert.equal((await as('authenticated',U,'{}',`UPDATE public.menu_items SET name='revoked' WHERE tenant_id='${A}' RETURNING id`)).rows.length,0);
 await q(`UPDATE public.tenant_memberships SET role='owner' WHERE user_id='${U}'`);
 pass('Menu items: routed public reads, member CRUD, immutable ownership, validation, global-admin denial, revocation and publication removal');
}
