// FS-01A: isolated native rehearsal. Never connects to any cloud project.
// Reuses the certified baseline + TING-11 disposable reconstruction.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {rehearseTing11} from './ting11.mjs';

const A='10000000-0000-4000-8000-000000000011';
const B='10000000-0000-4000-8000-000000000012';
const ITEM_A='30000000-0000-4000-8000-000000000011';
const ITEM_B='30000000-0000-4000-8000-000000000014';
const MIGRATION='20261116000000_fs01a_menu_category_allergen_contract.sql';

export async function rehearseFs01a(db,status,report,command,workdir) {
 const pass=s=>{report.checks.push(s);console.log('PASS: '+s);};
 const denied=async(p,label)=>{const r=await p; assert(r.error,label+' unexpectedly succeeded');return r.error;};
 const ok=(r,label)=>{assert(!r.error,label+': '+(r.error?.code??'unknown'));return r.data;};
 const sql=readFileSync(new URL('../../migrations/'+MIGRATION,import.meta.url),'utf8');

 // Establish the exact same mature tenant/order baseline, including order snapshots.
 await rehearseTing11(db,status,report,command,workdir);
 const before=(await db.query('SELECT id,tenant_id,subtotal,total,status FROM public.orders ORDER BY id')).rows;
 const linesBefore=(await db.query('SELECT id,order_id,menu_item_id,item_name_snapshot,unit_price_snapshot,line_total FROM public.order_items ORDER BY id')).rows;

 const directory=join(workdir,'supabase/migrations');
 writeFileSync(join(directory,MIGRATION),sql);
 command(['db','push','--local','--dry-run','--skip-vault','--yes']);
 assert.equal((await db.query("SELECT to_regclass('public.menu_categories') AS value")).rows[0].value,null,'dry run mutated schema');
 command(['db','push','--local','--skip-vault','--yes']);
 assert((await db.query("SELECT to_regclass('public.menu_categories') AS value")).rows[0].value,'migration not applied');
 const applied=(await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(x=>x.version);
 assert(applied.includes('20261116000000'),'migration ledger did not record FS-01A');
 command(['db','push','--local','--skip-vault','--yes']);
 assert.deepEqual((await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows.map(x=>x.version),applied,'repeated push changed migration ledger');
 pass('FS-01A CLI dry-run, native apply, ledger and repeated no-op');

 assert.equal((await db.query('SELECT count(*)::int n FROM public.menu_item_allergen_reviews')).rows[0].n,
 (await db.query('SELECT count(*)::int n FROM public.menu_items')).rows[0].n,
 'existing items not backfilled as unverified');
 assert.equal((await db.query('SELECT count(*)::int n FROM public.menu_items WHERE category_id IS NOT NULL')).rows[0].n,0,'legacy category was silently invented');
 assert.deepEqual((await db.query('SELECT id,tenant_id,subtotal,total,status FROM public.orders ORDER BY id')).rows,before,'order snapshots changed');
 assert.deepEqual((await db.query('SELECT id,order_id,menu_item_id,item_name_snapshot,unit_price_snapshot,line_total FROM public.order_items ORDER BY id')).rows,linesBefore,'order-item snapshots changed');
 pass('Historical dishes retained as uncategorised and order snapshots unchanged');

 const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const service=createClient(status.API_URL,status.SERVICE_ROLE_KEY,opts);
 const client=(slug)=>createClient(status.API_URL,status.ANON_KEY,{...opts,global:{headers:{'x-client-slug':slug}}});
 const anonA=client('order-a'),anonB=client('order-b'),ownerA=client('order-a'),
       ownerWrongRoute=client('order-b'),floorA=client('order-a'),ordinary=client('order-a');
 try {
  const pw=randomUUID()+'Aa1!';
  const makeUser=async(label)=>{
   const email='fs01a-'+label+'-'+randomUUID()+'@example.com';
   const user=ok(await service.auth.admin.createUser({email,password:pw,email_confirm:true}),'user create').user;
   return {user,email};
  };
  const owner=await makeUser('owner'), floor=await makeUser('floor'), outsider=await makeUser('outsider');
  await db.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'floor')",[A,owner.user.id,floor.user.id]);
  ok(await ownerA.auth.signInWithPassword({email:owner.email,password:pw}),'owner sign in');
  ok(await ownerWrongRoute.auth.signInWithPassword({email:owner.email,password:pw}),'wrong route sign in');
  ok(await floorA.auth.signInWithPassword({email:floor.email,password:pw}),'floor sign in');
  ok(await ordinary.auth.signInWithPassword({email:outsider.email,password:pw}),'outsider sign in');
  await db.query("NOTIFY pgrst,'reload schema'");
  let ready=false;for(let t=0;t<30;t++){
   const q=await anonA.from('menu_categories').select('id').limit(1);
   if(!q.error){ready=true;break;}
   await new Promise(r=>setTimeout(r,500));
  }
  assert(ready,'new category REST schema cache not ready');
  await denied(anonA.from('menu_categories').insert({tenant_id:A,name:'Forged'}),'anon category write');
  await denied(floorA.from('menu_categories').insert({tenant_id:A,name:'Forged floor'}),'floor category write');
  await denied(ordinary.from('menu_categories').insert({tenant_id:A,name:'Forged outsider'}),'outsider category write');
  const cat=ok(await ownerA.from('menu_categories').insert({tenant_id:A,name:'Mains',sort_order:2}).select().single(),'category A insert');
  await db.query("INSERT INTO public.menu_categories(tenant_id,name) VALUES ($1,'Tenant B Specials')",[B]);
  assert.equal(ok(await anonA.from('menu_categories').select('name'),'route A category list').length,1);
  assert.equal(ok(await anonB.from('menu_categories').select('name'),'route B category list').length,1);
  assert.equal(ok(await ownerWrongRoute.from('menu_categories').select('id'),'wrong route plus membership categories').length,2,'public route B plus owner membership A should be independently scoped');
  const foreignCat=(await db.query("SELECT id FROM public.menu_categories WHERE tenant_id=$1",[B])).rows[0].id;
  await denied(ownerA.from('menu_items').update({category_id:foreignCat}).eq('id',ITEM_A),'cross tenant category FK');
  ok(await ownerA.from('menu_items').update({category_id:cat.id}).eq('id',ITEM_A).select().single(),'same tenant assignment');
  await denied(ownerA.from('menu_categories').delete().eq('id',cat.id),'category delete with items');
  pass('Tenant-aware category CRUD, staff/outsider denial, cross-tenant FK and delete restriction');

  assert((await db.query('SELECT safety_version,verified_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[ITEM_A])).rows[0].verified_version===null,'new data unexpectedly verified');
  assert((await anonA.rpc('get_menu_allergen_status')).data?.some(x=>x.menu_item_id===ITEM_A&&x.state==='unknown'&&x.review_current===false),'guest missing unknown/unverified default');
  await denied(anonA.rpc('verify_menu_item_allergens',{p_item_id:ITEM_A,p_expected_version:1}),'anon forge verification');
  await denied(floorA.rpc('verify_menu_item_allergens',{p_item_id:ITEM_A,p_expected_version:1}),'Floor forge verification');
  await denied(ordinary.rpc('verify_menu_item_allergens',{p_item_id:ITEM_A,p_expected_version:1}),'outsider forge verification');
  await denied(ownerA.from('menu_item_allergen_reviews').update({verified_version:1,verified_by:owner.user.id,verified_at:new Date().toISOString()}).eq('menu_item_id',ITEM_A),'direct forged review');

  let v=1;
  v=ok(await ownerA.rpc('set_menu_item_safety_context',{p_item_id:ITEM_A,p_recipe:'reviewed recipe',p_preparation:'separate utensils',p_expected_version:v}),'context edit');
  assert.equal(v,2);
  v=ok(await ownerA.rpc('set_menu_item_allergen',{p_item_id:ITEM_A,p_code:'milk',p_state:'assessed_absent',p_evidence_note:'supplier checked',p_expected_version:v}),'milk assessment');
  assert.equal(v,3);
  await denied(ownerA.rpc('set_menu_item_allergen',{p_item_id:ITEM_A,p_code:'egg',p_state:'contains',p_expected_version:2}),'stale assessment');
  await denied(ownerA.rpc('verify_menu_item_allergens',{p_item_id:ITEM_A,p_expected_version:v}),'incomplete review');
  // Service-side fixture seeding is deliberately privileged: trigger must invalidate too.
  await db.query("INSERT INTO public.menu_item_allergen_assessments(tenant_id,menu_item_id,allergen_code,state) SELECT $1,$2,code,'assessed_absent' FROM public.menu_allergen_codes WHERE code <> 'milk'",[A,ITEM_A]);
  v=Number((await db.query('SELECT safety_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[ITEM_A])).rows[0].safety_version);
  assert.equal(v,25,'privileged assessment writes did not invalidate once per row');
  ok(await ownerA.rpc('verify_menu_item_allergens',{p_item_id:ITEM_A,p_expected_version:v}),'owner verify');
  const verified=(await db.query('SELECT safety_version,verified_version,verified_by,verified_at FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[ITEM_A])).rows[0];
  assert.equal(Number(verified.safety_version),Number(verified.verified_version));assert.equal(verified.verified_by,owner.user.id);assert(verified.verified_at);
  const statuses=ok(await anonA.rpc('get_menu_allergen_status'),'guest verified status');
  assert.equal(statuses.filter(x=>x.menu_item_id===ITEM_A&&x.review_current).length,23);
  assert(statuses.every(x=>!('recipe_context'in x)&&!('verified_by'in x)&&!('evidence_note'in x)));
  assert(!ok(await anonB.rpc('get_menu_allergen_status'),'tenant B status').some(x=>x.menu_item_id===ITEM_A));
  pass('Authenticated reviewed-allergen lifecycle and guest safe projection');

  const edited=ok(await ownerA.from('menu_items').update({description:'New recipe ingredients'}).eq('id',ITEM_A).select().single(),'description edit');
  assert(edited);
  const invalidated=(await db.query('SELECT safety_version,verified_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[ITEM_A])).rows[0];
  assert.equal(Number(invalidated.safety_version),v+1);assert.equal(invalidated.verified_version,null);
  assert(ok(await anonA.rpc('get_menu_allergen_status'),'guest after invalidation').some(x=>x.menu_item_id===ITEM_A&&x.review_current===false));
  await denied(ownerA.rpc('verify_menu_item_allergens',{p_item_id:ITEM_B,p_expected_version:1}),'foreign tenant review');
  await denied(ownerWrongRoute.rpc('verify_menu_item_allergens',{p_item_id:ITEM_B,p_expected_version:1}),'route spoof foreign review');
  pass('Description-change invalidation, cross-tenant review denial and stale guest status');
 } finally {
  await Promise.allSettled([service.removeAllChannels(),anonA.removeAllChannels(),anonB.removeAllChannels(),ownerA.removeAllChannels(),ownerWrongRoute.removeAllChannels(),floorA.removeAllChannels(),ordinary.removeAllChannels()]);
 }
}
