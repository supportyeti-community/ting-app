import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '../../baseline/node_modules/@electric-sql/pglite/dist/index.js';

const read = path => readFileSync(new URL(path, import.meta.url),'utf8');
const db=new PGlite();
const a='d8e68393-70de-4e77-8c07-51992f2b64a6';
const b='b8e68393-70de-4e77-8c07-51992f2b64a6';
const admin='20000000-0000-4000-8000-000000000001';
const other='20000000-0000-4000-8000-000000000002';
const name='11111111-1111-4111-8111-111111111111.png';
const as=async(role,user,sql)=>{
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user??'']);
    return await db.query(sql);
  } finally { await db.exec('ROLLBACK'); }
};
const count=async(role,user,where)=>Number((await as(role,user,`SELECT count(*) n FROM storage.objects WHERE bucket_id='menu-pictures' AND ${where}`)).rows[0].n);
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE supabase_admin;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    CREATE SCHEMA storage;
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated;
    GRANT ALL ON storage.objects TO anon, authenticated;
    SET ting.baseline_replay='approved-empty-target';
  `);
  await db.exec(read('../../baseline/schema.sql'));
  await db.exec(`
    CREATE FUNCTION ting_private.can_manage_tenant(target uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
      SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tenant_memberships m WHERE m.user_id=auth.uid()
          AND m.tenant_id=target AND m.role IN ('owner','admin'));
    $$;
    REVOKE ALL ON FUNCTION ting_private.can_manage_tenant(uuid) FROM PUBLIC,anon,authenticated;
    GRANT USAGE ON SCHEMA ting_private TO authenticated;
    GRANT EXECUTE ON FUNCTION ting_private.can_manage_tenant(uuid) TO authenticated;
    INSERT INTO auth.users(id) VALUES ('${admin}'),('${other}');
    INSERT INTO public.admin_users(user_id) VALUES ('${admin}');
    INSERT INTO public.tenants(id,client_slug) VALUES ('${a}','the-bistro'),('${b}','other-tenant');
    INSERT INTO public.tenant_memberships(tenant_id,user_id,role)
      VALUES ('${a}','${admin}','owner'),('${b}','${other}','owner');
    INSERT INTO storage.objects(bucket_id,name) VALUES
      ('menu-pictures','legacy.jpg'),('menu-pictures','${a}/${name}'),('menu-pictures','${b}/${name}');
  `);
  await db.exec(read('../../migrations/20260923200127_ting4_restrict_menu_picture_listing.sql'));
  const migration=read('../../migrations/20260924035638_ting4_scope_menu_picture_writes.sql');
  await db.exec('ALTER POLICY "Admins can upload menu pictures" ON storage.objects WITH CHECK (true)');
  await assert.rejects(db.exec(migration),/preflight drift/);
  await db.exec('ROLLBACK');
  await db.exec('ALTER POLICY "Admins can upload menu pictures" ON storage.objects WITH CHECK (bucket_id = \'menu-pictures\' AND public.is_admin())');
  await db.exec(migration);
  assert.equal(await count('authenticated',admin,`name='legacy.jpg'`),1);
  assert.equal(await count('authenticated',admin,`name='${a}/${name}'`),1);
  assert.equal(await count('authenticated',admin,`name='${b}/${name}'`),0);
  assert.equal(await count('authenticated',other,`name='${b}/${name}'`),1);
  assert.equal(await count('authenticated',other,`name='legacy.jpg'`),0);
  assert.equal(await count('anon',null,'true'),0);
  console.log('PASS: legacy read and A/B isolation');
  const insert=(path,role,user)=>as(role,user,`INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-pictures','${path}')`);
  await insert(`${a}/22222222-2222-4222-8222-222222222222.jpg`,'authenticated',admin);
  await insert(`${b}/22222222-2222-4222-8222-222222222222.png`,'authenticated',other);
  for(const path of [`${b}/33333333-3333-4333-8333-333333333333.png`,
    'legacy-new.png',`${a}/not-uuid.png`,`${a}/44444444-4444-4444-8444-444444444444.gif`,
    `${a.toUpperCase()}/55555555-5555-4555-8555-555555555555.png`]) {
    await assert.rejects(insert(path,'authenticated',admin));
  }
  await assert.rejects(insert(`${a}/66666666-6666-4666-8666-666666666666.png`,'authenticated',other));
  await assert.rejects(insert(`${a}/77777777-7777-4777-8777-777777777777.png`,'anon',null));
  assert.equal((await as('authenticated',admin,`UPDATE storage.objects SET name='${b}/${name}' WHERE name='${a}/${name}'`)).affectedRows,0);
  console.log('PASS: membership, path validation, and no cross-prefix update');
  await db.exec(`DELETE FROM public.tenant_memberships WHERE tenant_id='${b}'`);
  await assert.rejects(insert(`${b}/88888888-8888-4888-8888-888888888888.png`,'authenticated',other));
  assert.equal(await count('authenticated',other,`name='${b}/${name}'`),0);
  await assert.rejects(db.exec(migration),/preflight drift/);
  await db.exec('ROLLBACK');
  console.log('PASS: revocation and repeated migration fail-closed');
} finally { await db.close(); }
