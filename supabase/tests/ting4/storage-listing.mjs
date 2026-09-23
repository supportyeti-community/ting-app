// Disposable PostgreSQL policy rehearsal. The native Storage API is checked separately.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '../../baseline/node_modules/@electric-sql/pglite/dist/index.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const db = new PGlite();
const admin = '20000000-0000-4000-8000-000000000001';
const ordinary = '20000000-0000-4000-8000-000000000002';
const migration = read('../../migrations/20260923194905_ting4_restrict_menu_picture_listing.sql');
const query = sql => db.query(sql);
const policies = async () => (await query("SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname")).rows;
const as = async (role, user, sql) => {
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user ?? '']);
    return await query(sql);
  } finally { await db.exec('ROLLBACK'); }
};
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
  await db.exec(`INSERT INTO auth.users(id) VALUES ('${admin}'), ('${ordinary}');
    INSERT INTO public.admin_users(user_id) VALUES ('${admin}');
    INSERT INTO storage.objects(bucket_id,name) VALUES ('menu-pictures','legacy.jpg');`);
  const before = await policies();
  assert.equal(before.length,4);
  assert.equal((await as('anon',null,"SELECT count(*)::integer AS n FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].n,1);
  assert.equal((await as('authenticated',ordinary,"SELECT count(*)::integer AS n FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].n,1);
  console.log('PASS: old anonymous and ordinary listing reproduced');

  await db.exec('ALTER POLICY "Public can view menu pictures" ON storage.objects USING (true)');
  await assert.rejects(db.exec(migration),/preflight drift/);
  await db.exec('ROLLBACK');
  assert.equal((await policies()).length,4);
  await db.exec('ALTER POLICY "Public can view menu pictures" ON storage.objects USING (bucket_id = \'menu-pictures\')');
  console.log('PASS: drift rejects atomically');

  await db.exec(migration);
  const after = await policies();
  assert.equal(after.length,4);
  assert.deepEqual(after.filter(p=>p.cmd!=='SELECT'),before.filter(p=>p.cmd!=='SELECT'));
  assert.equal(after.find(p=>p.cmd==='SELECT').policyname,'Admins can list menu pictures');
  assert.equal((await as('anon',null,"SELECT count(*)::integer AS n FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].n,0);
  assert.equal((await as('authenticated',ordinary,"SELECT count(*)::integer AS n FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].n,0);
  assert.equal((await as('authenticated',admin,"SELECT count(*)::integer AS n FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].n,1);
  assert.equal((await query("SELECT public FROM storage.buckets WHERE id='menu-pictures'")).rows[0].public,true);
  assert.equal((await query("SELECT name FROM storage.objects WHERE bucket_id='menu-pictures'")).rows[0].name,'legacy.jpg');
  console.log('PASS: listing roles, legacy object, bucket setting, and write policies');
  await assert.rejects(db.exec(migration),/preflight drift/);
  await db.exec('ROLLBACK');
  assert.deepEqual(await policies(),after);
  console.log('PASS: repeat application rejects without change');
} finally { await db.close(); }
