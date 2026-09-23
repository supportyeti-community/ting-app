import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {A,B,U,V,G} from './verify.mjs';

export const ticketMigrationName='20260923101432_ting2_service_ticket_authorization.sql';
export const ticketMigration=readFileSync(new URL('../../migrations/'+ticketMigrationName,import.meta.url),'utf8');

export async function verifyServiceTickets(db,pass,apply=()=>db.query(ticketMigration)) {
 const q=(sql,params)=>db.query(sql,params);
 const as=async(role,user,headers,sql)=>{
  await q('BEGIN');
  try {
   await q(`SET LOCAL ROLE ${role}`);
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.headers',$3,true)",[user||'',JSON.stringify({sub:user,role,user_metadata:{tenant_id:B,role:'owner'}}),headers]);
   return await q(sql);
  } finally {await q('ROLLBACK');}
 };
 const denied=async fn=>{let error;try{await fn();}catch(e){error=e;}assert(error&&['42501','23514','23502'].includes(error.code),'Expected ticket authorization/ownership rejection');};

 await q('DELETE FROM public.service_tickets');
 await q(`INSERT INTO public.service_tickets(tenant_id,client_slug,table_number,request_type,status) VALUES
 ('${A}','test-a','1','Baseline A','pending'),
 ('${B}','test-b','2','Baseline B','pending')`);
 await q(`ALTER TABLE public.service_tickets DISABLE TRIGGER a_assign_service_ticket_tenant;
  INSERT INTO public.service_tickets(tenant_id,client_slug,table_number,request_type,status)
  VALUES ('${A}',NULL,'legacy','Historical route','resolved');
  ALTER TABLE public.service_tickets ENABLE TRIGGER a_assign_service_ticket_tenant;`);
 assert.equal((await as('authenticated',G,'{}','SELECT id FROM public.service_tickets')).rows.length,3);
 await as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.service_tickets(client_slug,table_number,request_type) VALUES ('test-b','3','Route gap')`);
 pass('Live baseline reproduced: global-admin ticket read and payload-selected public routing');

 await apply();
 assert.equal((await q(`SELECT count(*)::int AS n FROM public.service_tickets WHERE tenant_id='${A}' AND client_slug='test-a'`)).rows[0].n,2);
 assert.equal((await q("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='service_tickets' AND column_name='client_slug'")).rows[0].is_nullable,'NO');

 for(const headers of ['{}','','not-json','{"x-client-slug":"unknown"}'])
  await denied(()=>as('anon',null,headers,`INSERT INTO public.service_tickets(table_number,request_type) VALUES ('4','Missing route')`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.service_tickets(tenant_id,client_slug,table_number,request_type) VALUES ('${B}','test-a','4','Foreign owner')`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.service_tickets(client_slug,table_number,request_type) VALUES ('test-b','4','Foreign slug')`));
 await as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.service_tickets(table_number,request_type) VALUES ('4','Canonical route')`);
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}','SELECT id FROM public.service_tickets'));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`UPDATE public.service_tickets SET status='resolved'`));
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`DELETE FROM public.service_tickets`));

 for(const [user,own,other] of [[U,A,B],[V,B,A]]) {
  const rows=(await as('authenticated',user,'{}','SELECT tenant_id FROM public.service_tickets')).rows;
  assert(rows.length>0 && rows.every(row=>row.tenant_id===own));
  assert.equal((await as('authenticated',user,'{}',`UPDATE public.service_tickets SET status='resolved' WHERE tenant_id='${own}' RETURNING id`)).rows.length,rows.length);
  assert.equal((await as('authenticated',user,'{}',`UPDATE public.service_tickets SET status='resolved' WHERE tenant_id='${other}' RETURNING id`)).rows.length,0);
  await denied(()=>as('authenticated',user,'{}',`UPDATE public.service_tickets SET table_number='99' WHERE tenant_id='${own}'`));
  await denied(()=>as('authenticated',user,'{}',`DELETE FROM public.service_tickets WHERE tenant_id='${own}'`));
 }
 assert.equal((await as('authenticated',G,'{"x-client-slug":"test-b"}','SELECT id FROM public.service_tickets')).rows.length,0);
 await denied(()=>as('authenticated',G,'{}','TRUNCATE public.service_tickets'));
 await q(`UPDATE public.tenant_memberships SET role='viewer' WHERE user_id='${U}'`);
 assert.equal((await as('authenticated',U,'{}',`UPDATE public.service_tickets SET status='pending' WHERE tenant_id='${A}' RETURNING id`)).rows.length,0);
 await q(`UPDATE public.tenant_memberships SET role='owner' WHERE user_id='${U}'`);
 assert.equal((await q("SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='service_tickets'")).rows[0].n,1);
 pass('Service tickets: canonical route-bound inserts, member read/status update, immutable request details, no client delete, global-admin denial and immediate revocation');
}
