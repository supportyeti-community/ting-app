import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {verifyIsolation} from '../tests/ting2/verify.mjs';
import {verifyMenuItems} from '../tests/ting2/menu-items.mjs';
import {verifyMenuEvents} from '../tests/ting2/menu-events.mjs';
const db=new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$; GRANT USAGE ON SCHEMA auth TO anon,authenticated; CREATE SCHEMA storage; CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text); CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; SET ting.baseline_replay='approved-empty-target';`);
await db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
// PGlite exec accepts multi-statements while query uses the extended protocol.
const adapter={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1))};
await verifyIsolation(adapter,label=>console.log('PASS: '+label));
await verifyMenuItems(adapter,label=>console.log('PASS: '+label));
await verifyMenuEvents(adapter,label=>console.log('PASS: '+label));
await db.close();
