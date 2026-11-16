import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {rehearseFs01a} from './fs01a.mjs';
const A='10000000-0000-4000-8000-000000000011';
const B='10000000-0000-4000-8000-000000000012';
const MIGRATION='20261117000000_fs01b_bulk_menu_draft_import.sql';
export async function rehearseFs01b(db,status,report,command,workdir){
 const pass=t=>{report.checks.push(t);console.log('PASS: '+t);};
 const ok=(result,label)=>{assert(!result.error,label+': '+(result.error?.code||'unknown'));return result.data;};
 const denied=async(result,label)=>assert((await result).error,label+' unexpectedly succeeded');
 await rehearseFs01a(db,status,report,command,workdir);
 const beforeOrders=(await db.query('SELECT id,subtotal,total,status FROM public.orders ORDER BY id')).rows;
 const beforeItems=(await db.query('SELECT id,tenant_id,name,price FROM public.menu_items ORDER BY id')).rows;
 const sql=readFileSync(new URL('../../migrations/'+MIGRATION,import.meta.url),'utf8');
 writeFileSync(join(workdir,'supabase/migrations',MIGRATION),sql);
 command(['db','push','--local','--dry-run','--skip-vault','--yes']);
 assert.equal((await db.query("SELECT to_regclass('public.menu_import_batches') AS v")).rows[0].v,null);
 command(['db','push','--local','--skip-vault','--yes']);
 command(['db','push','--local','--skip-vault','--yes']);
 pass('Stacked FS-01A + FS-01B native disposable migrations, dry-run/apply/no-op');
 const opts={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
 const svc=createClient(status.API_URL,status.SERVICE_ROLE_KEY,opts);
 const client=slug=>createClient(status.API_URL,status.ANON_KEY,{...opts,global:{headers:{'x-client-slug':slug}}});
 const owner=client('order-a'),floor=client('order-a'),outsider=client('order-a'),wrongRoute=client('order-b'),anonymous=client('order-a');
 try{
  const password=randomUUID()+'Aa1!';
  async function user(role){
   const email='fs01b-'+role+'-'+randomUUID()+'@example.com';
   const record=ok(await svc.auth.admin.createUser({email,password,email_confirm:true}),'create user '+role).user;
   return {email,id:record.id};
  }
  const o=await user('owner'),f=await user('floor'),n=await user('outsider');
  await db.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'floor')",[A,o.id,f.id]);
  for(const [cl,email] of [[owner,o.email],[floor,f.email],[outsider,n.email],[wrongRoute,o.email]])
   ok(await cl.auth.signInWithPassword({email,password}),'sign in');
  await db.query("NOTIFY pgrst,'reload schema'");
  const rows=Array.from({length:120},(_,i)=>({
   category:i<60?'Lunch':'Dinner',name:'Import test dish '+i,
   description:'Verified by nobody; imported draft',price:(i+1)+'.50',
   available:i%2===0,image_url:''
  }));
  const request=randomUUID();
  let result;
  for(let t=0;t<30;t++){
   const r=await owner.rpc('import_menu_draft',{p_request_id:request,p_rows:rows});
   if(!r.error){result=r.data;break;}
   if(r.error.code!=='PGRST202')throw Error('import RPC error: '+r.error.code);
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(result,'import RPC not visible');
  assert.equal(result.saved,120);assert.equal(result.items.length,120);
  const saved=await db.query('SELECT id,tenant_id,import_draft,is_out_of_stock FROM public.menu_items WHERE name LIKE $1',['Import test dish %']);
  assert.equal(saved.rows.length,120);
  assert(saved.rows.every(x=>x.tenant_id===A&&x.import_draft===true&&x.is_out_of_stock===true));
  const review=(await db.query('SELECT verified_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=ANY($1::uuid[])',[saved.rows.map(x=>x.id)])).rows;
  assert.equal(review.length,120);assert(review.every(x=>x.verified_version===null));
  pass('120-row real REST owner import, tenant-owned categories, draft/out-of-stock, unverified review triggers');
  assert.deepEqual(ok(await owner.rpc('import_menu_draft',{p_request_id:request,p_rows:rows}),'retry'),result);
  await denied(owner.rpc('import_menu_draft',{p_request_id:request,p_rows:rows.slice(0,119)}),'conflicting retry');
  await denied(wrongRoute.rpc('import_menu_draft',{p_request_id:request,p_rows:rows}),'cross-route tenant');
  await denied(floor.rpc('import_menu_draft',{p_request_id:randomUUID(),p_rows:rows.slice(0,1)}),'Floor');
  await denied(outsider.rpc('import_menu_draft',{p_request_id:randomUUID(),p_rows:rows.slice(0,1)}),'outsider');
  await denied(anonymous.rpc('import_menu_draft',{p_request_id:randomUUID(),p_rows:rows.slice(0,1)}),'anon');
  pass('Idempotent exact retry, conflict rejection, Floor/outsider/anon/wrong-tenant denial');
  const rejected=[
   [{...rows[0],name:'Bad negative',price:'-1'}],
   [{...rows[0],name:'Bad cents',price:'1.999'}],
   [{...rows[0],name:''}],
   [{...rows[0],name:'Same name'},{...rows[0],name:'same name'}],
   [{...rows[0],name:'new item',category_id:randomUUID()}],
   [{...rows[0],name:'new item',image_url:'javascript:alert(1)'}]
  ];
  const count=Number((await db.query('SELECT count(*) n FROM public.menu_items WHERE tenant_id=$1',[A])).rows[0].n);
  for(const bad of rejected)await denied(owner.rpc('import_menu_draft',{p_request_id:randomUUID(),p_rows:bad}),'malformed batch');
  assert.equal(Number((await db.query('SELECT count(*) n FROM public.menu_items WHERE tenant_id=$1',[A])).rows[0].n),count);
  pass('Malformed prices, missing name, same-batch duplicate, forged category ID and image URL rejected atomically');
  const concurrentRows=[{category:'Special',name:'Concurrent single',price:'12.50',available:true}];
  const concurrencyId=randomUUID();
  const racing=await Promise.all([owner.rpc('import_menu_draft',{p_request_id:concurrencyId,p_rows:concurrentRows}),owner.rpc('import_menu_draft',{p_request_id:concurrencyId,p_rows:concurrentRows})]);
  assert(racing.every(x=>!x.error));assert.deepEqual(racing[0].data,racing[1].data);
  assert.equal(Number((await db.query("SELECT count(*) n FROM public.menu_items WHERE name='Concurrent single'")).rows[0].n),1);
  pass('Concurrent same-key request single-winner and stable replay result');
  assert.deepEqual((await db.query('SELECT id,subtotal,total,status FROM public.orders ORDER BY id')).rows,beforeOrders);
  for(const old of beforeItems){
   const current=(await db.query('SELECT id,tenant_id,name,price FROM public.menu_items WHERE id=$1',[old.id])).rows[0];
   assert.deepEqual(current,old);
  }
  pass('Existing item and historical order preservation');
  const first=saved.rows[0].id;
  assert((await db.query('SELECT verified_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[first])).rows[0].verified_version===null);
  await denied(owner.rpc('verify_menu_item_allergens',{p_item_id:first,p_expected_version:1}),'verify unassessed dish');
  pass('Imported dish requires FS-01A complete structured assessment and authorised verification');
 }finally{await Promise.allSettled([svc.removeAllChannels(),owner.removeAllChannels(),floor.removeAllChannels(),outsider.removeAllChannels(),wrongRoute.removeAllChannels(),anonymous.removeAllChannels()]);}
}
