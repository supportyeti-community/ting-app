import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {G} from './verify.mjs';

export const routeScopeMigrationName = '20260923130750_ting2_route_scope_registry.sql';
export const routeScopeMigration = readFileSync(new URL('../../migrations/'+routeScopeMigrationName,import.meta.url),'utf8');

export async function verifyRoutingScope(db,pass,apply=()=>db.query(routeScopeMigration)) {
 const q=(sql,params)=>db.query(sql,params);
 await q("INSERT INTO public.restaurant_clients(client_slug,supabase_url,supabase_anon_key,restaurant_name) VALUES ('the-bistro','http://127.0.0.1:54321','public-demo-key','Bistro')");
 await q("INSERT INTO public.restaurant_clients(client_slug,supabase_url,supabase_anon_key,restaurant_name) VALUES ('test-b','http://127.0.0.1:54321','public-b-key','B')");
 await apply();
 const as=async(role,user,headers,sql)=>{
  await q('BEGIN');
  try {
   await q(`SET LOCAL ROLE ${role}`);
   await q("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.headers',$3,true)",[user||'',JSON.stringify({sub:user,role}),headers]);
   return (await q(sql)).rows;
  } finally {await q('ROLLBACK');}
 };
 const rows=(role,user,headers)=>as(role,user,headers,'SELECT client_slug FROM public.restaurant_clients ORDER BY client_slug');
 for(const [role,user] of [['anon',null],['authenticated',G]]) {
  assert.deepEqual(await rows(role,user,'{}'),[{client_slug:'the-bistro'}]);
  assert.deepEqual(await rows(role,user,''),[{client_slug:'the-bistro'}]);
  assert.deepEqual(await rows(role,user,'{"x-client-slug":"the-bistro"}'),[{client_slug:'the-bistro'}]);
  assert.deepEqual(await rows(role,user,'{"x-client-slug":"test-b"}'),[{client_slug:'test-b'}]);
  for(const headers of ['not-json','[]','null','{"x-client-slug":"unknown"}','{"x-client-slug":""}','{"x-client-slug":null}','{"x-client-slug":" test-b"}'])
   assert.deepEqual(await rows(role,user,headers),[]);
  assert.deepEqual(await as(role,user,'{"x-client-slug":"test-b"}',"SELECT client_slug FROM public.restaurant_clients WHERE client_slug = 'the-bistro'"),[]);
  // A forged known slug reveals only that public route; it gives no membership.
  assert.deepEqual(await as(role,user,'{"x-client-slug":"test-b"}',"SELECT client_slug FROM public.restaurant_clients WHERE client_slug = 'test-a'"),[]);
 }
 assert.equal((await q("SELECT count(*)::int AS count FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_clients' AND cmd='SELECT'")).rows[0].count,1);
 assert.equal((await q("SELECT public.is_admin() AS allowed")).rows[0].allowed,false);
 pass('Route registry limits reads to exact header; legacy headerless Bistro only; unknown and malformed fail closed');
}
