// WRK-16 Path B only. No production endpoints or credentials accepted.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {rehearsePay2} from './wrk16/payment-behavior.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const read=n=>readFileSync(join(root,'wrk16',n),'utf8');
const json=n=>JSON.parse(read(n));
const sha=s=>createHash('sha256').update(s).digest('hex');
const stable=x=>Array.isArray(x)?x.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const report={scope:'WRK-16 Path B: certified production catalogue plus recorded Storage closure; synthetic data; disposable native runtime',production_writes:0,checks:[],commands:[],main:'931216a696ef28de0cc693836aa7f4d2f354ae56'};
const pass=x=>{report.checks.push(x);console.log('PASS: '+x)};
const workdir=mkdtempSync(join(tmpdir(),'ting-pathb-')),project=workdir.split('/').at(-1);
const cli=join(root,'node_modules/.bin/supabase');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(SUPABASE_|PG|DATABASE_URL|DOCKER_HOST|DOCKER_CONTEXT)/.test(k)));
function command(args){
 const r=spawnSync(cli,[...args,'--workdir',workdir],{encoding:'utf8',timeout:600000,maxBuffer:16*1024*1024,env});
 report.commands.push({args,exit:r.status});
 if(r.status!==0)throw new Error('Local CLI '+args.slice(0,2).join(' ')+' failed; output withheld');
 return r.stdout;
}
let db,status;
const ledger=async()=> (await db.query('SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
const capture=async()=> (await db.query(read('capture.sql'))).rows[0].snapshot;
function equalCatalogue(actual,expected,label,capText=false){
 const a=structuredClone(actual),b=structuredClone(expected);
 delete a.captured_at;delete b.captured_at;
 if(capText)for(const c of [a,b])for(const f of c.functions)if(f.schema==='ting_private'&&['issue_table_access_context','revoke_table_access_context','rotate_table_access_context'].includes(f.name))f.definition=f.definition.replace(/--[^\n]*/g,'').replace(/\s+/g,'').toLowerCase();
 const different=Object.keys(b).filter(k=>JSON.stringify(stable(a[k]))!==JSON.stringify(stable(b[k])));
 report[label]={result:different.length?'FAIL':'PASS',different};
 assert.equal(different.length,0,label+': '+different.join(','));
 pass(label);
}
async function roleQuery(role,slug,sql,args=[],sub=null){
 const c=new pg.Client({connectionString:status.DB_URL});await c.connect();
 try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='15s'");await c.query('SET LOCAL ROLE '+role);
 await c.query("SELECT set_config('request.headers',$1,true),set_config('request.jwt.claim.sub',$2,true)",[JSON.stringify({'x-client-slug':slug}),sub||'']);
 const r=await c.query(sql,args);await c.query('COMMIT');return r;
 }catch(e){await c.query('ROLLBACK');throw e}finally{await c.end()}
}
const A='10000000-0000-4000-8000-000000000011',B='10000000-0000-4000-8000-000000000012';
async function order(total=100){const id=randomUUID();await db.query("INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id) VALUES($1,$2,'PAY2-A','submitted',$3,$3,$4)",[id,A,total,randomUUID()]);return id}
async function deny(p,label){try{await p}catch(e){assert(['42501','23514','23503','P0001','22023','42883'].includes(e.code),label+' unexpected SQLSTATE '+e.code);return}throw new Error(label+' unexpectedly allowed')}
try{
 report.cli=command(['--version']).trim();
 command(['--help']);command(['start','--help']);command(['db','push','--help']);command(['migration','repair','--help']);
 command(['init','--yes']);
 const config=join(workdir,'supabase/config.toml');let text=readFileSync(config,'utf8');assert(text.includes('major_version = 17'));writeFileSync(config,text.replace(/project_id = "[^"]+"/,'project_id = "'+project+'"'));
 command(['start','-x','studio,edge-runtime,logflare,vector,supavisor,postgres-meta']);
 status=JSON.parse(command(['status','-o','json']));
 for(const k of ['DB_URL','API_URL'])assert.equal(new URL(status[k]).hostname,'127.0.0.1');
 db=new pg.Client({connectionString:status.DB_URL});await db.connect();
 report.postgres=(await db.query('SELECT version() AS v')).rows[0].v;
 await db.query("SET ting.baseline_replay='approved-empty-target'");
 await db.query(read('starting-schema.sql'));
 equalCatalogue(await capture(),json('starting-catalogue.json'),'production_equivalent_start');
 const history=json('production-ledger.json'),correlation=json('ledger-correlation.json');
 const dir=join(workdir,'supabase/migrations');mkdirSync(dir,{recursive:true});
 // Preserve production aliases in a throwaway deployment manifest; never rename repo files.
 for(const item of correlation.filter(x=>x.prod)){
  const name=item.prod.version+'_'+item.prod.name+'.sql';
  writeFileSync(join(dir,name),'-- Already applied; certified SCHEMA-1 correlation. Never execute.\n');
 }
 command(['migration','repair',...history.map(x=>x.version),'--local','--status','applied']);
 for(const h of history)await db.query('UPDATE supabase_migrations.schema_migrations SET name=$2 WHERE version=$1',[h.version,h.name]);
 const beforeLedger=await ledger();assert.equal(beforeLedger.length,27);
 report.aliases=correlation.filter(x=>x.prod&&x.repo.split('_')[0]!==x.prod.version).map(x=>({repo:x.repo,production:x.prod.version}));
 assert.equal(report.aliases.length,6);
 await db.query("INSERT INTO public.tenants(id,client_slug) VALUES($1,'order-a'),($2,'order-b')",[A,B]);
 const legacy=await order();
 const oldAttempt=(await roleQuery('anon','order-a','SELECT (public.create_payment_attempt($1,25,$2)).*',[legacy,randomUUID()])).rows[0];
 await db.query("SELECT ting_private.confirm_payment_attempt($1,'test','legacy_synthetic',25,'AUD')",[oldAttempt.id]);
 const legacySnapshot=async()=> (await db.query("SELECT jsonb_build_object('order',(SELECT to_jsonb(o) FROM public.orders o WHERE id=$1),'attempt',(SELECT to_jsonb(a)-'provider_account_id' FROM public.payment_attempts a WHERE id=$2),'allocations',(SELECT jsonb_agg(to_jsonb(a)) FROM public.payment_allocations a WHERE payment_attempt_id=$2)) AS s",[legacy,oldAttempt.id])).rows[0].s;
 const beforeData=await legacySnapshot();
 const pending=correlation.filter(x=>!x.prod).map(x=>x.repo).sort();
 assert.deepEqual(pending,['20261015020000_pay2_current_main_recovery.sql','20261031104500_pay2_unbound_confirmation_account_check.sql']);
 report.pending=[];
 for(const name of pending){
  const sql=readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
  report.pending.push({file:name,sha256:sha(sql)});writeFileSync(join(dir,name),sql);
 }
 // Earlier PAY-2 timestamps require explicit include-all, with aliases already resolved.
 const dry=command(['db','push','--local','--dry-run','--include-all','--skip-vault','--yes']);
 for(const name of pending)assert(dry.includes(name),'Dry-run omitted '+name);
 assert.deepEqual(await ledger(),beforeLedger);equalCatalogue(await capture(),json('starting-catalogue.json'),'dry_run_schema_unchanged');
 command(['db','push','--local','--include-all','--skip-vault','--yes']);
 const afterLedger=await ledger();assert.equal(afterLedger.length,29);
 assert.deepEqual(afterLedger.filter(x=>!pending.some(p=>p.startsWith(x.version))),beforeLedger);
 assert.deepEqual(await legacySnapshot(),beforeData);pass('Pre-existing partial payment, attempt and allocation survive upgrade unchanged');
 equalCatalogue(await capture(),json('expected-final.json'),'final_schema_grants_rls',true);
 const afterSchema=await capture();
 command(['db','push','--local','--include-all','--skip-vault','--yes']);
 assert.deepEqual(await ledger(),afterLedger);equalCatalogue(await capture(),afterSchema,'repeat_upgrade_no_op');
 assert.deepEqual(await legacySnapshot(),beforeData);
 report.ledger={before:beforeLedger,after:afterLedger,strategy:'Preserve all 27 production versions. Six certified aliases represented only in disposable manifest. Apply two genuine pending versions with include-all. No production ledger repair proposed as prerequisite.'};
 pass('Only two pending migrations applied; six timestamp aliases preserved; repeat is a no-op');
 await rehearsePay2(db,status,report,command,workdir);
 // Real concurrent sessions, queued together behind a held order row lock.
 async function race(sqls,oid){
  await db.query('BEGIN');await db.query('SELECT 1 FROM public.orders WHERE id=$1 FOR UPDATE',[oid]);
  const clients=await Promise.all(sqls.map(async()=>{const c=new pg.Client({connectionString:status.DB_URL});await c.connect();return c}));
  const pids=[];
  for(const c of clients){await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='15s'");await c.query('SET LOCAL ROLE anon');await c.query("SELECT set_config('request.headers',$1,true)",[JSON.stringify({'x-client-slug':'order-a'})]);pids.push((await c.query('SELECT pg_backend_pid() AS p')).rows[0].p)}
  const calls=clients.map((c,i)=>c.query(sqls[i].sql,sqls[i].args).then(async r=>{await c.query('COMMIT');return {ok:true,rows:r.rows}},async e=>{await c.query('ROLLBACK');return {ok:false,code:e.code}}));
  let blocked=0;
  for(let i=0;i<100;i++){blocked=(await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",[pids])).rows[0].n;if(blocked===clients.length)break;await new Promise(r=>setTimeout(r,20))}
  await db.query('COMMIT');
  const result=await Promise.all(calls);await Promise.all(clients.map(c=>c.end()));
  assert.equal(blocked,clients.length,'Concurrency barrier did not queue every session');
  return result;
 }
 const sql='SELECT (public.create_payment_attempt($1,$2,$3,$4)).*';
 const oid=await order();
 const over=await race([1,2].map(()=>({sql,args:[oid,60,randomUUID(),'a'.repeat(64)]})),oid);
 assert.equal(over.filter(x=>x.ok).length,1);assert.equal(over.filter(x=>!x.ok).length,1);
 const balance=(await roleQuery('anon','order-a','SELECT * FROM public.get_order_payment_balance($1)',[oid])).rows[0];
 assert.equal(Number(balance.amount_reserved),60);assert.equal(Number(balance.amount_available),40);
 pass('Two synchronized 60/100 reservations: exactly one wins; balance never over-reserved');
 const oid2=await order(),request=randomUUID();
 const same=await race(Array.from({length:8},()=>({sql,args:[oid2,30,request,'a'.repeat(64)]})),oid2);
 assert(same.every(x=>x.ok));assert.equal(new Set(same.map(x=>x.rows[0].id)).size,1);
 const attempt=same[0].rows[0].id;
 assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_attempts WHERE tenant_id=$1 AND client_request_id=$2',[A,request])).rows[0].n,1);
 pass('Eight synchronized retries produce exactly one canonical reservation');
 await roleQuery('service_role','order-a',"SELECT public.bind_payment_provider($1,'stripe','acct_ting_test_a','pi_concurrent')",[attempt]);
 const confirms=await Promise.all(Array.from({length:8},()=>roleQuery('service_role','order-a',"SELECT public.confirm_payment_attempt_trusted($1,'stripe','acct_ting_test_a','pi_concurrent',30,'AUD')",[attempt])));
 assert.equal(confirms.length,8);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[attempt])).rows[0].n,1);
 pass('Eight concurrent trusted confirmations allocate once');
 const remainder=(await roleQuery('anon','order-a',sql,[oid2,70,randomUUID(),'a'.repeat(64)])).rows[0];
 await roleQuery('service_role','order-a',"SELECT public.confirm_payment_attempt_trusted($1,'stripe','acct_ting_test_a','pi_split',70,'AUD')",[remainder.id]);
 assert.equal((await db.query('SELECT payment_status FROM public.orders WHERE id=$1',[oid2])).rows[0].payment_status,'paid');
 pass('Concurrent-path split allocations reach paid exactly at total');
 await deny(roleQuery('anon','order-b',sql,[oid2,1,randomUUID(),'a'.repeat(64)]),'cross tenant');
 await deny(roleQuery('anon','',sql,[oid,1,randomUUID(),'a'.repeat(64)]),'missing route');
 await deny(roleQuery('anon','unknown',sql,[oid,1,randomUUID(),'a'.repeat(64)]),'unknown route');
 const uid=randomUUID();await db.query('INSERT INTO auth.users(id) VALUES($1)',[uid]);
 await db.query("INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[B,uid]);
 for(const role of ['anon','authenticated']){
  await deny(roleQuery(role,'order-a',"INSERT INTO public.payment_allocations(tenant_id,order_id,payment_attempt_id,amount) VALUES($1,$2,$3,1)",[A,oid,attempt],uid),'browser payment allocation write');
  await deny(roleQuery(role,'order-a',"SELECT public.confirm_payment_attempt_trusted($1,'stripe','acct_ting_test_a','pi_concurrent',30,'AUD')",[attempt],uid),'browser trusted confirm');
  await deny(roleQuery(role,'order-a','SELECT * FROM public.tenant_payment_accounts',[],uid),'browser account mapping read');
 }
 await deny(roleQuery('authenticated','order-a',"UPDATE public.orders SET status='accepted' WHERE id=$1 RETURNING id",[oid],uid).then(r=>{if(r.rowCount===0){const e=new Error();e.code='42501';throw e}return r}),'foreign member forged route');
 await deny(db.query('UPDATE public.payment_attempts SET tenant_id=$1 WHERE id=$2',[B,attempt]),'composite tenant coupling');
 pass('Anon/authenticated restrictions, forged route, missing route and composite tenant coupling fail closed');
 // Account-check follow-up: unbound confirmations must still match the tenant mapping.
 const fresh=await order(),unbound=(await roleQuery('anon','order-a',sql,[fresh,100,randomUUID(),'a'.repeat(64)])).rows[0];
 await deny(roleQuery('service_role','order-a',"SELECT public.confirm_payment_attempt_trusted($1,'stripe','acct_ting_wrong','pi_unbound',100,'AUD')",[unbound.id]),'unbound account mismatch');
 assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[unbound.id])).rows[0].n,0);
 pass('Follow-up migration rejects wrong-account confirmation before provider binding');
 report.result='PASS';
}catch(e){report.result='FAIL';report.failure={message:e.message,code:e.code};process.exitCode=1}
finally{
 if(db)await db.end().catch(()=>{});
 try{command(['stop','--project-id',project,'--no-backup']);report.cleanup='PASS'}catch{report.cleanup='FAIL';report.result='FAIL';process.exitCode=1}
 rmSync(workdir,{recursive:true,force:true});
 writeFileSync(join(root,'wrk16-result.json'),JSON.stringify(report,null,2)+'\n');
 console.log('WRK16_RESULT_BEGIN');console.log(JSON.stringify(report,null,2));console.log('WRK16_RESULT_END');
}
