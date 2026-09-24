import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {historicalFiles} from './history.mjs';

const migrations = fileURLToPath(new URL('../../migrations/',import.meta.url));
const target = '20260923200127_ting4_restrict_menu_picture_listing.sql';
const memberTarget = '20260924035638_ting4_scope_menu_picture_writes.sql';
export async function rehearseTing4(db,{admin,ordinary,visitor},report,command,workdir,status) {
  const pass = label => { report.checks.push(label);console.log('PASS: '+label); };
  const ok = (r,label) => { assert(!r.error,`${label} failed`);return r.data; };
  const files = readdirSync(migrations).filter(name=>/^\d+_.*\.sql$/.test(name) && name!==target && name!==memberTarget).sort();
  historicalFiles();
  assert.equal(files.length,15,'Unexpected source migration count');
  const directory = join(workdir,'supabase/migrations');mkdirSync(directory,{recursive:true});
  for (const file of files) writeFileSync(join(directory,file),readFileSync(join(migrations,file)));
  command(['migration','repair',...files.map(file=>file.split('_')[0]),'--local','--status','applied']);
  const ledger = async()=>(await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(r=>r.version);
  const oldLedger=await ledger();
  assert.deepEqual(oldLedger,files.map(file=>file.split('_')[0]));
  const before=(await db.query("SELECT policyname,cmd,roles,qual,with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname")).rows;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const name='ting4-list-check.png';
  ok(await admin.storage.from('menu-pictures').upload(name,png,{contentType:'image/png',upsert:false}),'Initial admin upload');
  assert(ok(await visitor.storage.from('menu-pictures').list(),'Initial anon list').some(r=>r.name===name));
  assert(ok(await ordinary.storage.from('menu-pictures').list(),'Initial ordinary list').some(r=>r.name===name));
  pass('Storage API reproduces anonymous and ordinary enumeration');
  const publicUrl=admin.storage.from('menu-pictures').getPublicUrl(name).data.publicUrl;
  assert.equal(new URL(publicUrl).origin,new URL(status.API_URL).origin);
  const original=await fetch(publicUrl,{signal:AbortSignal.timeout(10000)});
  assert(original.ok);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()),png);
  writeFileSync(join(directory,target),readFileSync(join(migrations,target)));
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),oldLedger);
  assert(ok(await visitor.storage.from('menu-pictures').list(),'Dry-run list').some(r=>r.name===name));
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),[...oldLedger,target.split('_')[0]]);
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),[...oldLedger,target.split('_')[0]]);
  pass('CLI dry-run, apply once and repeated no-op preserve fifteen prior versions');
  assert.deepEqual(ok(await visitor.storage.from('menu-pictures').list(),'Anon list after change'),[]);
  assert.deepEqual(ok(await ordinary.storage.from('menu-pictures').list(),'Ordinary list after change'),[]);
  assert(ok(await admin.storage.from('menu-pictures').list(),'Admin list after change').some(r=>r.name===name));
  const after=(await db.query("SELECT policyname,cmd,roles,qual,with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname")).rows;
  assert.deepEqual(after.filter(p=>p.cmd!=='SELECT'),before.filter(p=>p.cmd!=='SELECT'));
  assert.equal(after.length,before.length);
  assert.equal(after.find(p=>p.cmd==='SELECT').policyname,'Admins can list menu pictures');
  pass('Real Storage list denies anon and ordinary, retains admin listing and write policies');
  const unchanged=await fetch(publicUrl,{signal:AbortSignal.timeout(10000)});
  assert(unchanged.ok);
  assert.deepEqual(Buffer.from(await unchanged.arrayBuffer()),png);
  ok(await admin.storage.from('menu-pictures').upload('ting4-new-unique.png',png,{contentType:'image/png',upsert:false}),'New admin upload');
  assert((await ordinary.storage.from('menu-pictures').upload('ting4-denied.png',png,{contentType:'image/png',upsert:false})).error);
  const auth=ok(await admin.auth.getUser(),'Existing admin identity').user;
  const tenantId=randomUUID();
  await db.query('INSERT INTO public.tenants(id,client_slug) VALUES ($1,$2)',[tenantId,'ting4-path-test']);
  await db.query('INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)',[tenantId,auth.id,'owner']);
  const prefixedPath=`${tenantId}/${randomUUID()}.png`;
  ok(await admin.storage.from('menu-pictures').upload(prefixedPath,png,{contentType:'image/png',upsert:false}),'Prefixed admin upload');
  const prefixedUrl=admin.storage.from('menu-pictures').getPublicUrl(prefixedPath).data.publicUrl;
  const prefixedResponse=await fetch(prefixedUrl,{signal:AbortSignal.timeout(10000)});
  assert(prefixedResponse.ok);
  assert.deepEqual(Buffer.from(await prefixedResponse.arrayBuffer()),png);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id=$1 AND name=$2',['menu-pictures',prefixedPath])).rows[0].n,1);
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='menu-pictures'")).rows[0].public,true);
  pass('Known public URL, unique and tenant-prefixed admin uploads work; ordinary upload denied');
}

export async function rehearseTing4Membership(db,{admin,ordinary,visitor},report,command,workdir,status) {
  await rehearseTing4(db,{admin,ordinary,visitor},report,command,workdir,status);
  const pass = label => { report.checks.push(label); console.log('PASS: '+label); };
  const ok = (r,label) => { assert(!r.error,`${label} failed`); return r.data; };
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const bistro='d8e68393-70de-4e77-8c07-51992f2b64a6';
  const b=randomUUID();
  const adminId=ok(await admin.auth.getUser(),'Admin identity').user.id;
  const ordinaryId=ok(await ordinary.auth.getUser(),'Ordinary identity').user.id;
  // The native baseline snapshot predates TING-2; its migration ledger is
  // repaired for the listing rehearsal. Recreate the reviewed membership
  // helper here to exercise the new Storage policy against real Auth/Storage.
  await db.query(`CREATE FUNCTION ting_private.can_manage_tenant(target uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
      SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tenant_memberships m WHERE m.user_id=auth.uid()
          AND m.tenant_id=target AND m.role IN ('owner','admin'));
    $$;
    REVOKE ALL ON FUNCTION ting_private.can_manage_tenant(uuid) FROM PUBLIC,anon,authenticated,service_role;
    GRANT USAGE ON SCHEMA ting_private TO authenticated;
    GRANT EXECUTE ON FUNCTION ting_private.can_manage_tenant(uuid) TO authenticated;`);
  await db.query('INSERT INTO public.tenants(id,client_slug) VALUES ($1,$2),($3,$4)',[bistro,'the-bistro',b,'other-tenant']);
  await db.query('INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,$3),($4,$5,$6)',[bistro,adminId,'owner',b,ordinaryId,'owner']);
  const pathA=`${bistro}/${randomUUID()}.png`;
  const pathB=`${b}/${randomUUID()}.png`;
  ok(await admin.storage.from('menu-pictures').upload(pathA,png,{contentType:'image/png',upsert:false}),'Pre-policy A upload');
  ok(await admin.storage.from('menu-pictures').upload(pathB,png,{contentType:'image/png',upsert:false}),'Pre-policy foreign upload reproduction');
  const legacy='ting4-list-check.png';
  const legacyUrl=admin.storage.from('menu-pictures').getPublicUrl(legacy).data.publicUrl;
  const directory=join(workdir,'supabase/migrations');
  writeFileSync(join(directory,memberTarget),readFileSync(join(migrations,memberTarget)));
  const ledger=async()=>(await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(r=>r.version);
  const before=await ledger();
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),before);
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),[...before,memberTarget.split('_')[0]]);
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),[...before,memberTarget.split('_')[0]]);
  pass('Membership migration dry-run, apply once, repeat no-op');
  assert((await admin.storage.from('menu-pictures').list(bistro)).data.some(x=>x.name===pathA.split('/')[1]));
  assert(!(await admin.storage.from('menu-pictures').list(b)).data?.some(x=>x.name===pathB.split('/')[1]));
  assert((await ordinary.storage.from('menu-pictures').list(b)).data.some(x=>x.name===pathB.split('/')[1]));
  assert.deepEqual(ok(await visitor.storage.from('menu-pictures').list(),'Anonymous list'),[]);
  assert(ok(await admin.storage.from('menu-pictures').list(),'Bistro list').some(x=>x.name===legacy));
  pass('Tenant A/B listing isolation and legacy Bistro read');
  ok(await admin.storage.from('menu-pictures').upload(`${bistro}/${randomUUID()}.jpg`,png,{contentType:'image/jpeg',upsert:false}),'A member upload');
  ok(await ordinary.storage.from('menu-pictures').upload(`${b}/${randomUUID()}.png`,png,{contentType:'image/png',upsert:false}),'B member upload');
  for(const bad of [`${b}/${randomUUID()}.png`,`${randomUUID()}/${randomUUID()}.png`,'cached-flat.png',`${bistro}/not-a-uuid.png`,`${bistro}/${randomUUID()}.gif`,`${bistro.toUpperCase()}/${randomUUID()}.png`]) {
    assert((await admin.storage.from('menu-pictures').upload(bad,png,{contentType:'image/png',upsert:false})).error,`Admin accepted unauthorized path: ${bad}`);
  }
  assert((await ordinary.storage.from('menu-pictures').upload(`${bistro}/${randomUUID()}.png`,png,{contentType:'image/png',upsert:false})).error);
  assert((await admin.storage.from('menu-pictures').upload(pathA,png,{contentType:'image/png',upsert:true})).error);
  assert((await ordinary.storage.from('menu-pictures').upload(pathB,png,{contentType:'image/png',upsert:true})).error);
  pass('Cross-tenant, flat, malformed, and upsert writes denied');
  assert((await fetch(legacyUrl,{signal:AbortSignal.timeout(10000)})).ok);
  const aUrl=admin.storage.from('menu-pictures').getPublicUrl(pathA).data.publicUrl;
  assert((await fetch(aUrl,{signal:AbortSignal.timeout(10000)})).ok);
  assert.equal((await db.query("SELECT public FROM storage.buckets WHERE id='menu-pictures'")).rows[0].public,true);
  pass('Existing flat and prefixed public URLs survive');
  await db.query('DELETE FROM public.tenant_memberships WHERE tenant_id=$1 AND user_id=$2',[b,ordinaryId]);
  assert((await ordinary.storage.from('menu-pictures').upload(`${b}/${randomUUID()}.png`,png,{contentType:'image/png',upsert:false})).error);
  assert.deepEqual(ok(await ordinary.storage.from('menu-pictures').list(b),'Revoked B list'),[]);
  pass('Membership revocation takes effect without token refresh');
}
