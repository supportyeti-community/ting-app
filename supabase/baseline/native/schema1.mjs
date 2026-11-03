// Native-only SCHEMA-1 verification; invoked after verify() validates loopback URLs.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {historicalFiles} from './history.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const BISTRO='d8e68393-70de-4e77-8c07-51992f2b64a6';
const stable=x=>Array.isArray(x)?x.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export async function rehearseSchema1(db,clients,status,report,command,workdir){
 const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};
 assert.equal(new URL(status.DB_URL).hostname,'127.0.0.1');
 assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');
 const directory=join(workdir,'supabase/migrations');mkdirSync(directory,{recursive:true});
 const history=historicalFiles();
 for(const f of history)writeFileSync(join(directory,f.filename),f.sql);
 command(['migration','repair',...history.map(x=>x.version),'--local','--status','applied']);
 for(const f of history)await db.query('UPDATE supabase_migrations.schema_migrations SET name=$2,statements=$3 WHERE version=$1',[f.version,f.name,[f.sql]]);
 const ledger=async()=>(await db.query('SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
 const migrations=new URL('../../migrations/',import.meta.url);
 const files=readdirSync(migrations).filter(x=>/^\d+_.*\.sql$/.test(x)&&!history.some(h=>h.filename===x)).sort();
 assert.equal(files.length,20,'Expected reviewed 20-file forward chain');
 report.bootstrap={contract:'verified September baseline + nine unchanged history records + chronological forward migrations',completed:[],fixtures:['synthetic routing registry prerequisite','historical Bistro tenant prerequisite; no production rows copied']};
 for(const f of files){
  if(f.includes('_route_scope_registry'))await db.query("INSERT INTO public.restaurant_clients(client_slug,supabase_url,supabase_anon_key,restaurant_name) VALUES ('the-bistro','http://127.0.0.1:54321','synthetic-public-placeholder','Bistro')");
  if(f.includes('_scope_menu_picture_writes'))await db.query("INSERT INTO public.tenants(id,client_slug) VALUES ($1,'the-bistro')",[BISTRO]);
  writeFileSync(join(directory,f),readFileSync(new URL(f,migrations)));
  const before=await ledger();
  try{command(['db','push','--local','--dry-run','--skip-vault','--yes']);assert.deepEqual(await ledger(),before);command(['db','push','--local','--skip-vault','--yes']);}
  catch(e){report.bootstrap.failed_migration=f;throw e;}
  const after=await ledger();assert.equal(after.length,before.length+1);assert.equal(after.at(-1).version,f.split('_')[0]);report.bootstrap.completed.push(f);
 }
 const complete=await ledger();command(['db','push','--local','--skip-vault','--yes']);assert.deepEqual(await ledger(),complete);
 pass('All 20 forward migrations applied chronologically; dry-runs and repeated push preserve ledger');
 const capture=read('../capture.sql').split('\n').filter(l=>!l.includes(" 'buckets',")).join('\n');
 const snapshot=(await db.query(capture)).rows[0].snapshot;
 writeFileSync(new URL('schema1/native-catalogue.json',import.meta.url),JSON.stringify(snapshot,null,2));
 report.bootstrap.ledger=complete;
 await verifyStorage(db,clients,report,pass);
}
async function verifyStorage(db,{admin,ordinary,visitor,service},report,pass){
 const ok=(r,label)=>{assert(!r.error,label+' failed');return r.data;};
 const aid=ok(await admin.auth.getUser(),'A identity').user.id;
 const bid=ok(await ordinary.auth.getUser(),'B identity').user.id;
 const A=randomUUID(),B=randomUUID();
 await db.query('INSERT INTO public.tenants(id,client_slug) VALUES ($1,$2),($3,$4)',[A,'schema1-a',B,'schema1-b']);
 await db.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')",[A,aid,B,bid]);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const upload=(client,path)=>client.storage.from('menu-pictures').upload(path,png,{contentType:'image/png',upsert:false});
 const remove=(client,path)=>client.storage.from('menu-pictures').remove([path]);
 const exists=async path=>(await db.query('SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id=$1 AND name=$2',['menu-pictures',path])).rows[0].n===1;
 const policy=async()=>(await db.query("SELECT policyname,cmd,roles,permissive,qual,with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname")).rows;
 const desired=await policy();
 // Reproduce captured production predicate only on this disposable local stack.
 await db.query(read('schema1/deployed-storage-delete.sql'));
 const deployed=await policy();
 const pathA=`${A}/${randomUUID()}.png`,pathB=`${B}/${randomUUID()}.png`;
 ok(await upload(admin,pathA),'A canonical INSERT');ok(await upload(ordinary,pathB),'B canonical INSERT');
 const list=async(client,prefix)=>ok(await client.storage.from('menu-pictures').list(prefix),'Storage SELECT');
 assert((await list(admin,A)).some(x=>x.name===pathA.split('/')[1]));
 const oldDelete=await remove(admin,pathA);
 if(oldDelete.error)assert(oldDelete.error.message,'Historical DELETE returned an invalid error');
 assert(await exists(pathA),'Historical malformed DELETE unexpectedly removed canonical object');
 report.storage={historical_failure:'Canonical INSERT and SELECT succeed but DELETE leaves object under captured production predicate',production_writes:0};
 pass('Native Storage API reproduces deployed DELETE defect on canonical own-tenant object');
 await db.query(read('schema1/storage-delete-correction.sql'));
 assert.deepEqual(await policy(),desired,'Corrected policy must match reviewed repo catalogue');
 assert.deepEqual((await policy()).filter(x=>x.cmd!=='DELETE'),deployed.filter(x=>x.cmd!=='DELETE'),'INSERT/SELECT policies changed');
 const grantsBefore=(await db.query("SELECT relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='storage.objects'::regclass")).rows;
 const denyRemove=async(client,path,label)=>{
  const r=await remove(client,path);if(r.error)assert(r.error.message,label+' invalid error');
  assert(await exists(path),label+' deleted an object');
 };
 await denyRemove(ordinary,pathA,'Wrong-tenant member');await denyRemove(visitor,pathA,'Anonymous');await denyRemove(admin,pathB,'Opposite tenant');
 assert(!(await list(ordinary,A)).some(x=>x.name===pathA.split('/')[1]));
 assert((await upload(ordinary,`${A}/${randomUUID()}.png`)).error,'Cross-tenant INSERT accepted');
 pass('Wrong-tenant and anonymous DELETE denied; SELECT and INSERT remain tenant-scoped');
 const malformed=[`${A}/12345678-1234-1234-123456789abc.png`,`${A}/not-a-uuid.png`,`not-a-tenant/${randomUUID()}.png`,`${A}/nested/${randomUUID()}.png`,`${A}/${randomUUID()}.gif`,`flat-schema1.png`];
 for(const path of malformed){
  assert((await upload(admin,path)).error,'Malformed INSERT accepted');
  ok(await upload(service,path),'Synthetic malformed fixture creation');
  await denyRemove(admin,path,'Malformed-path DELETE');
 }
 pass('Malformed tenant/path/filename/extension INSERT and DELETE fail closed');
 const deleted=ok(await remove(admin,pathA),'Authorised canonical DELETE');
 assert(Array.isArray(deleted)&&deleted.some(x=>x.name===pathA),'DELETE did not report canonical object');
 assert(!(await exists(pathA)),'Authorised object persisted');
 ok(await remove(ordinary,pathB),'B canonical DELETE');assert(!(await exists(pathB)));
 pass('Authorised A and B tenant members delete their own canonical objects through native Storage API');
 // Managed Storage intentionally rejects direct SQL DELETE, even for an owner.
 // Exercise that platform boundary without disabling it; API checks above prove RLS.
 const remaining=`${A}/${randomUUID()}.png`;ok(await upload(admin,remaining),'Restricted role fixture');
 for(const user of [aid,bid]){
  await db.query('BEGIN');let blocked=false;
  try{await db.query('SET LOCAL ROLE authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2',['menu-pictures',remaining]);}
  catch(e){blocked=e.message==='Direct deletion from storage tables is not allowed. Use the Storage API instead.';}
  finally{await db.query('ROLLBACK');}
  assert(blocked,'Managed direct-SQL deletion protection changed');
 }
 assert(await exists(remaining));
 assert((await admin.storage.from('menu-pictures').upload(remaining,png,{contentType:'image/png',upsert:true})).error,'UPDATE/upsert access widened');
 pass('Native authenticated SQL roles retain managed direct-deletion protection; API upsert remains denied');
 let rejected=false;try{await db.query(read('schema1/storage-delete-correction.sql'));}catch(e){rejected=e.message==='SCHEMA-1 policy precondition changed; stop';await db.query('ROLLBACK');}
 assert(rejected,'Repeated correction did not reject stale state');assert.deepEqual(await policy(),desired);
 assert.deepEqual((await db.query("SELECT relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='storage.objects'::regclass")).rows,grantsBefore);
 pass('Repeated guarded correction rejects stale state without changing policies, grants or RLS');
 for(const path of [...malformed,remaining])ok(await remove(service,path),'Synthetic object cleanup');
 report.storage.result='PASS';
}
