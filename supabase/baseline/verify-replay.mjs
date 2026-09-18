// Isolated PostgreSQL engine replay with MINIMAL managed-service fixtures.
// This is not a full Supabase stack, REST, Auth or Realtime service test.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('.', import.meta.url));
const source = JSON.parse(readFileSync(root+'catalog.json','utf8'));
const db = new PGlite();
const version = (await db.query('select version() as version')).rows[0].version;
await db.exec(`
 CREATE ROLE anon;
 CREATE ROLE authenticated;
 CREATE ROLE service_role BYPASSRLS;
 CREATE ROLE supabase_admin;
 CREATE SCHEMA auth;
 CREATE TABLE auth.users (id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
 GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
 CREATE SCHEMA storage;
 CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
 CREATE TABLE storage.buckets (id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
 GRANT ALL ON storage.objects TO anon, authenticated, service_role;
`);
const sql=readFileSync(root+'schema.sql','utf8');
let guardRejected=false;
try { await db.exec(sql); } catch(e) { guardRejected=/approved-empty-target/.test(e.message); await db.exec('ROLLBACK'); }
assert(guardRejected,'Explicit target guard must reject default execution');
await db.exec("SET ting.baseline_replay='approved-empty-target'");
await db.exec(sql);
const actual=(await db.query(readFileSync(root+'capture.sql','utf8'))).rows[0].snapshot;
// Function pretty-printing and ACL array order may differ across engine builds.
const sorted = x => Array.isArray(x) ? x.map(sorted).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) : x && typeof x==='object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])) : x;
const sections=['schemas','tables','constraints','indexes','functions','triggers','policies','publications','publication_tables','buckets','event_triggers'];
const differences=[];
for(const key of sections) {
 try {assert.deepEqual(sorted(actual[key]),sorted(source[key]));}
 catch {differences.push(key);}
}
writeFileSync(root+'replay-actual.json',JSON.stringify(actual,null,2)+'\n');
assert.deepEqual(differences,[],'Catalogue sections differ: '+differences.join(', '));
for (const table of source.tables) {
 const restored=actual.tables.find(t=>t.schema===table.schema && t.name===table.name);
 assert.deepEqual(restored.columns,table.columns,'Column ordering differs: '+table.name);
}
assert.deepEqual(sorted(actual.default_acls.filter(x=>x.owner==='postgres')), sorted(source.default_acls.filter(x=>x.owner==='postgres')), 'Application-owner default ACLs differ');
assert.equal(actual.other_relations,null,'Unexpected uncaptured relation');
assert.equal(actual.custom_types,null,'Unexpected uncaptured custom type');
let nonemptyRejected=false;
try {await db.exec(sql);} catch(e) {nonemptyRejected=/nonempty application schemas/.test(e.message);await db.exec('ROLLBACK');}
assert(nonemptyRejected,'Second replay must refuse a populated target');
const report={engine:version,dependency:'@electric-sql/pglite@0.3.14',scope:'Application catalogue replay on minimal auth/storage fixtures; not a full Supabase restore',catalogue_sections_matched:sections,postgres_default_acls:'PASS',explicit_target_guard:'PASS',nonempty_target_guard:'PASS',production_writes:0};
writeFileSync(root+'verification.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
await db.close();
