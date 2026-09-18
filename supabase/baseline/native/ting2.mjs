import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {historicalFiles} from './history.mjs';
import {verifyIsolation,migration,migrationName,A,B} from '../../tests/ting2/verify.mjs';
export async function rehearseTing2(db,status,report,command,workdir) {
 const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};
 const directory=join(workdir,'supabase/migrations');mkdirSync(directory,{recursive:true});
 const history=historicalFiles();
 for(const f of history)writeFileSync(join(directory,f.filename),f.sql);
 command(['migration','repair',...history.map(r=>r.version),'--local','--status','applied']);
 for(const f of history)await db.query('UPDATE supabase_migrations.schema_migrations SET name=$2,statements=$3 WHERE version=$1',[f.version,f.name,[f.sql]]);
 const ledger=async()=>(await db.query('SELECT version,name,md5(array_to_string(statements,chr(10))) AS statements_md5 FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
 const before=await ledger();
 await verifyIsolation(db,pass,async()=>{
  writeFileSync(join(directory,migrationName),migration);
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),before);
  assert.equal((await db.query("SELECT to_regprocedure('public.request_tenant_id()') AS f")).rows[0].f,null);
  command(['db','push','--local','--skip-vault','--yes']);
  const applied=await ledger();assert.equal(applied.length,before.length+1);assert.deepEqual(applied.slice(0,-1),before);
  assert.equal(applied.at(-1).version,migrationName.split('_')[0]);
  command(['db','push','--local','--skip-vault','--yes']);assert.deepEqual(await ledger(),applied);
  pass('Actual TING-2 migration: native CLI dry-run, apply once and repeated no-op; original history unchanged');
 });
 const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const service=createClient(status.API_URL,status.SERVICE_ROLE_KEY,options);
 const visitor=createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':'test-a'}}});
 const missing=createClient(status.API_URL,status.ANON_KEY,options);
 const admin=createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':'test-b'}}});
 const ok=(r,label)=>{assert(!r.error,label);return r.data;};
 try {
  let ready=false;
  for(let i=0;i<30;i++) {const r=await visitor.rpc('request_tenant_id');if(!r.error&&r.data===A){ready=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert(ready,'PostgREST release schema cache ready');
  assert.equal(ok(await missing.rpc('request_tenant_id'),'Missing route RPC'),null);
  assert.deepEqual(ok(await visitor.from('restaurant_settings').select('tenant_id'),'Public settings'),[{tenant_id:A}]);
  assert.equal(ok(await missing.from('restaurant_settings').select('*'),'Missing context settings').length,0);
  assert((await visitor.from('table_configurations').select('*')).error,'Anonymous table links blocked');
  const email='ting2-'+randomUUID()+'@example.com',password=randomUUID()+'Aa1!';
  const user=ok(await service.auth.admin.createUser({email,password,email_confirm:true}),'Create tenant admin').user;
  await db.query('INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)',[A,user.id,'owner']);
  ok(await admin.auth.signInWithPassword({email,password}),'Real tenant admin login');
  // Header deliberately points to B: authorization still derives from membership A.
  assert.deepEqual(ok(await admin.from('table_configurations').select('tenant_id'),'Member links'),[{tenant_id:A}]);
  for(let i=0;i<2;i++)ok(await admin.from('table_configurations').upsert({tenant_id:A,source_table:'10',target_table:'11'},{onConflict:'tenant_id,source_table,target_table'}),'Repeated REST upsert');
  assert((await admin.from('table_configurations').insert({tenant_id:B,source_table:'10',target_table:'11'})).error,'Foreign REST insert blocked');
  assert.equal(ok(await admin.from('table_configurations').update({target_table:'19'}).eq('tenant_id',B).select(),'Foreign update').length,0);
  assert.equal(ok(await admin.from('table_configurations').delete().eq('tenant_id',B).select(),'Foreign delete').length,0);
  ok(await admin.from('table_configurations').delete().eq('tenant_id',A).eq('source_table','10'),'Own delete');
  await db.query('DELETE FROM public.tenant_memberships WHERE user_id=$1',[user.id]);
  assert.equal(ok(await admin.from('table_configurations').select('*'),'Revoked membership').length,0);
  pass('Real Auth/REST: public route, missing route, private denial, composite upsert, forged-header denial and immediate revocation');
 } finally {await Promise.allSettled([service.removeAllChannels(),visitor.removeAllChannels(),missing.removeAllChannels(),admin.removeAllChannels()]);}
}
