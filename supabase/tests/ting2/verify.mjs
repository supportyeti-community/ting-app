import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
export const migrationName = '20260918144301_ting2_settings_table_isolation.sql';
export const migration = readFileSync(new URL('../../migrations/'+migrationName,import.meta.url),'utf8');
export const A='10000000-0000-4000-8000-000000000001', B='10000000-0000-4000-8000-000000000002';
export const U='20000000-0000-4000-8000-000000000001', V='20000000-0000-4000-8000-000000000002', G='20000000-0000-4000-8000-000000000003';
export async function verifyIsolation(db, pass, apply=()=>db.query(migration)) {
 const q=(s,p)=>db.query(s,p);
 const as=async(role,user,headers,sql)=>{
  await q('BEGIN');
  try {
   await q(`SET LOCAL ROLE ${role}`);
   await q("SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true), set_config('request.headers',$3,true)",[user||'',JSON.stringify({sub:user,role,user_metadata:{tenant_id:B,role:'owner'}}),headers]);
   return await q(sql);
  } finally {await q('ROLLBACK');}
 };
 const denied=async fn=>{let err;try{await fn();}catch(e){err=e;}assert(err && ['42501','23514','23502'].includes(err.code),'Expected authorization/ownership rejection');};
 await q(`INSERT INTO auth.users(id) VALUES ('${U}'),('${V}'),('${G}'); INSERT INTO public.tenants(id,client_slug) VALUES ('${A}','test-a'),('${B}','test-b'); INSERT INTO public.admin_users(user_id) VALUES ('${G}');`);
 // Reproduce old global-admin cross-tenant writes before changing any policy.
 await as('authenticated',G,'{}',`INSERT INTO public.table_configurations(tenant_id,source_table,target_table) VALUES ('${B}','old','gap')`);
 pass('Baseline reproduces global-admin write into unrelated tenant');
 await q("INSERT INTO public.table_configurations(source_table,target_table) VALUES ('unowned','row')");
 try {await q(migration);assert.fail('Unowned migration accepted');}catch(e){await q('ROLLBACK');assert.match(e.message,/explicit ownership/);}
 assert.equal((await q("SELECT to_regprocedure('public.request_tenant_id()') AS f")).rows[0].f,null);
 await q("DELETE FROM public.table_configurations WHERE source_table='unowned'");
 await q(`INSERT INTO public.restaurant_settings(tenant_id) VALUES ('${A}'),('${A}')`);
 try {await q(migration);assert.fail('Duplicate settings accepted');}catch(e){await q('ROLLBACK');assert.equal(e.code,'23505');}
 await q(`DELETE FROM public.restaurant_settings WHERE tenant_id='${A}'`);
 pass('Unowned/duplicate rows reject migration atomically; correction permits retry');
 await apply();
 await q(`INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ('${A}','${U}','owner'),('${B}','${V}','admin'); INSERT INTO public.restaurant_settings(tenant_id,restaurant_name) VALUES ('${A}','A'),('${B}','B'); INSERT INTO public.table_configurations(tenant_id,source_table,target_table) VALUES ('${A}','1','2'),('${B}','1','2');`);
 for(const [user,own,other] of [[U,A,B],[V,B,A]]) for(const table of ['restaurant_settings','table_configurations']) {
  const rows=(await as('authenticated',user,'{}',`SELECT tenant_id FROM public.${table}`)).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].tenant_id,own);
  const change=table==='restaurant_settings'?"restaurant_name='changed'":"target_table='3'";
  assert.equal((await as('authenticated',user,'{}',`UPDATE public.${table} SET ${change} WHERE tenant_id='${own}' RETURNING tenant_id`)).rows.length,1);
  assert.equal((await as('authenticated',user,'{}',`DELETE FROM public.${table} WHERE tenant_id='${own}' RETURNING tenant_id`)).rows.length,1);
  for(const verb of [`UPDATE public.${table} SET ${change}`,`DELETE FROM public.${table}`]) assert.equal((await as('authenticated',user,JSON.stringify({'x-client-slug':'test-b'}),`${verb} WHERE tenant_id='${other}' RETURNING tenant_id`)).rows.length,0);
  const insert=table==='restaurant_settings'?`INSERT INTO public.${table}(tenant_id) VALUES ('${other}')`:`INSERT INTO public.${table}(tenant_id,source_table,target_table) VALUES ('${other}','3','4')`;
  await denied(()=>as('authenticated',user,'{}',insert));
  await denied(()=>as('authenticated',user,'{}',`UPDATE public.${table} SET tenant_id='${other}' WHERE tenant_id='${own}'`));
 }
 pass('Both tenant admins: own reads/updates/deletes allowed; foreign CRUD and reassignment denied');
 await as('authenticated',U,'{}',`INSERT INTO public.table_configurations(tenant_id,source_table,target_table) VALUES ('${A}','3','4')`);
 // Settings singleton replacement and repeated upsert exercise SELECT/INSERT/UPDATE together.
 await as('authenticated',U,'{}',`DELETE FROM public.restaurant_settings WHERE tenant_id='${A}'; INSERT INTO public.restaurant_settings(tenant_id) VALUES ('${A}'); INSERT INTO public.restaurant_settings(tenant_id,restaurant_name) VALUES ('${A}','upsert') ON CONFLICT(tenant_id) DO UPDATE SET restaurant_name=excluded.restaurant_name;`);
 await as('authenticated',U,'{}',`INSERT INTO public.table_configurations(tenant_id,source_table,target_table) VALUES ('${A}','1','2') ON CONFLICT(tenant_id,source_table,target_table) DO UPDATE SET target_table=excluded.target_table;`);
 for(const role of ['anon','authenticated']) {
  await denied(()=>as(role,role==='authenticated'?G:null,'{}',`TRUNCATE public.restaurant_settings`));
  await denied(()=>as(role,role==='authenticated'?G:null,'{}',`INSERT INTO public.table_configurations(tenant_id,source_table,target_table) VALUES ('${A}','3','4')`));
 }
 assert.equal((await as('authenticated',G,'{}','SELECT * FROM public.table_configurations')).rows.length,0);
 await denied(()=>as('authenticated',U,'{}',`INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ('${B}','${U}','owner')`));
 await q(`INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ('${B}','${U}','owner')`);
 await denied(()=>as('authenticated',U,'{}',`UPDATE public.table_configurations SET tenant_id='${B}' WHERE tenant_id='${A}'`));
 await q(`DELETE FROM public.tenant_memberships WHERE tenant_id='${B}' AND user_id='${U}'`);
 pass('Same table numbers coexist; upserts work; global allowlist, forged metadata, self-enrolment, TRUNCATE and multi-member transfers rejected');
 for(const headers of ['{}','','not-json','{"x-client-slug":"unknown"}','{"x-client-slug":" test-a"}']) {
  assert.equal((await as('anon',null,headers,'SELECT public.request_tenant_id() AS id')).rows[0].id,null);
  assert.equal((await as('anon',null,headers,'SELECT * FROM public.restaurant_settings')).rows.length,0);
 }
 const publicRows=(await as('anon',null,'{"x-client-slug":"test-a"}','SELECT tenant_id FROM public.restaurant_settings')).rows;
 assert.deepEqual(publicRows,[{tenant_id:A}]);
 await denied(()=>as('anon',null,'{"x-client-slug":"test-a"}',`INSERT INTO public.restaurant_settings(tenant_id) VALUES ('${A}')`));
 await denied(()=>as('anon',null,'{}','SELECT * FROM public.table_configurations'));
 await denied(()=>as('authenticated',U,'{}',"INSERT INTO public.table_configurations(source_table,target_table) VALUES ('5','6')"));
 assert.equal((await q("SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('restaurant_settings','table_configurations')")).rows.length,0);
 await q(`UPDATE public.tenant_memberships SET role='viewer' WHERE user_id='${U}';`);
 assert.equal((await as('authenticated',U,'{}','SELECT * FROM public.table_configurations')).rows.length,0);
 await q(`UPDATE public.tenant_memberships SET role='owner' WHERE user_id='${U}';`);
 pass('Public settings route fails closed; private links deny anon; membership downgrade takes effect; unsafe DELETE publication removed');
}
