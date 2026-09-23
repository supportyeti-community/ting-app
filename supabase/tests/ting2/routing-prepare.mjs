import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {G} from './verify.mjs';

export const routingMigrationName = '20260923113515_ting2_routing_registry_prepare.sql';
export const routingMigration = readFileSync(new URL('../../migrations/'+routingMigrationName,import.meta.url),'utf8');

export async function verifyRoutingPreparation(db,pass,apply=()=>db.query(routingMigration)) {
  const q=sql=>db.query(sql);
  if ((await q('SELECT count(*)::int AS count FROM public.restaurant_clients')).rows[0].count===0)
    await q("INSERT INTO public.restaurant_clients(client_slug,supabase_url,supabase_anon_key,restaurant_name) VALUES ('test-a','http://127.0.0.1:54321','test-public-key','Test A')");
  assert.equal((await q("SELECT has_table_privilege('anon','public.restaurant_clients','TRUNCATE') AS allowed")).rows[0].allowed,true);
  await apply();
  for(const [table,role,allowed] of [
    ['restaurant_clients','anon',['SELECT']],
    ['restaurant_clients','authenticated',['SELECT']],
    ['admin_users','anon',[]],
    ['admin_users','authenticated',['SELECT']],
  ]) {
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
      const actual=(await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,`public.${table}`,privilege])).rows[0].allowed;
      assert.equal(actual,allowed.includes(privilege),`${table} ${role} ${privilege}`);
    }
  }
  const as=async(role,user,headers,sql)=>{
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.headers',$3,true)",[
        user||'',JSON.stringify({sub:user,role}),JSON.stringify(headers),
      ]);
      return await q(sql);
    } finally {await q('ROLLBACK');}
  };
  const rejected=async fn=>{await assert.rejects(fn,e=>e.code==='42501');};
  const slug=(await q('SELECT client_slug FROM public.restaurant_clients LIMIT 1')).rows[0].client_slug;
  // Existing pages still load before the paired frontend deployment. The
  // global SELECT policy is deliberately left to the next release.
  const expected=(await q('SELECT count(*)::int AS count FROM public.restaurant_clients')).rows[0].count;
  assert.equal((await as('anon',null,{},'SELECT count(*)::int AS count FROM public.restaurant_clients')).rows[0].count,expected);
  assert.equal((await as('anon',null,{'x-client-slug':slug},'SELECT count(*)::int AS count FROM public.restaurant_clients')).rows[0].count,expected);
  await rejected(()=>as('anon',null,{},'TRUNCATE public.restaurant_clients'));
  await rejected(()=>as('authenticated',G,{},'TRUNCATE public.admin_users'));
  await rejected(()=>as('authenticated',G,{},"UPDATE public.restaurant_clients SET restaurant_name='forbidden'"));
  assert.equal((await as('authenticated',G,{},'SELECT public.is_admin() AS allowed')).rows[0].allowed,true);
  assert.equal((await as('authenticated',G,{},'SELECT count(*)::int AS count FROM public.admin_users')).rows[0].count,1);
  assert.equal((await as('anon',null,{},'SELECT public.is_admin() AS allowed')).rows[0].allowed,false);
  assert.equal((await q("SELECT count(*)::int AS count FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('restaurant_clients','admin_users')")).rows[0].count,0);
  pass('Routing preparation preserves old bootstrap and storage admin check; registry writes and table-wide client grants denied');
}
