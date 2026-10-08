import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { rehearsePay1 } from './pay1.mjs';

const A='10000000-0000-4000-8000-000000000011';
const STRIPE_A='acct_ting_test_a';
const STRIPE_WRONG='acct_ting_wrong';
const PAY2=[
  '20261008114500_pay2_processor_boundary.sql',
  '20261008114600_pay2_abort_unbound_attempt.sql',
  '20261008120500_pay2_connect_direct_charges.sql',
];
const sourceSql=name=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');

export async function rehearsePay2(db,status,report,command,workdir){
  const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};
  await rehearsePay1(db,status,report,command,workdir);

  const migrationDir=join(workdir,'supabase/migrations');
  for(const name of PAY2){
    writeFileSync(join(migrationDir,name),sourceSql(name));
    command(['db','push','--local','--dry-run','--skip-vault','--yes']);
    command(['db','push','--local','--skip-vault','--yes']);
    const version=name.split('_')[0];
    assert.equal((await db.query('SELECT count(*)::int n FROM supabase_migrations.schema_migrations WHERE version=$1',[version])).rows[0].n,1);
  }
  command(['db','push','--local','--skip-vault','--yes']);
  pass('PAY-2 migrations dry-run/apply individually and repeated push is a no-op');

  const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
  const visitorA=createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':'order-a'}}});
  const service=createClient(status.API_URL,status.SERVICE_ROLE_KEY,options);
  const ok=(r,label)=>{assert(!r.error,label+': '+(r.error?.code||'unknown'));return Array.isArray(r.data)?r.data[0]:r.data;};
  const denied=async(p,label)=>{const r=await p;assert(r.error,label+' unexpectedly succeeded');return r.error;};

  try{
    const orderA=randomUUID();
    await db.query(`INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id)
      VALUES ($1,$2,'PAY2','submitted',100,100,$3)`,[orderA,A,randomUUID()]);
    await db.query(`INSERT INTO public.tenant_payment_accounts(tenant_id,provider,provider_account_id,status)
      VALUES ($1,'stripe',$2,'active')`,[A,STRIPE_A]);

    await denied(visitorA.from('tenant_payment_accounts').select('*'),'anon tenant payment-account read');
    await denied(visitorA.from('tenant_payment_accounts').insert({tenant_id:A,provider:'stripe',provider_account_id:'acct_forged'}),'anon tenant payment-account write');
    pass('Stripe connected-account mapping is server-managed and browser-inaccessible');

    let ready=false;
    for(let i=0;i<30;i++){
      const r=await service.rpc('bind_payment_provider',{p_attempt_id:randomUUID(),p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_probe'});
      if(!r.error||!String(r.error.code||'').startsWith('PGRST')){ready=true;break;}
      await new Promise(x=>setTimeout(x,500));
    }
    assert(ready,'PostgREST PAY-2 Connect RPC cache not ready');

    const attempt=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:randomUUID()}),'create PAY-2 attempt');
    await denied(visitorA.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'anon bind');
    await denied(visitorA.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_terminal_status:'failed'}),'anon release');
    await denied(visitorA.rpc('confirm_payment_attempt_trusted',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_confirmed_amount:60,p_currency:'AUD'}),'anon trusted confirm');
    pass('Connect processor binding/release/confirmation RPCs are service-role-only');

    await denied(service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_A'}),'bind unknown tenant account');
    const bound=ok(await service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'service bind');
    assert.equal(bound.status,'pending');assert.equal(bound.provider,'stripe');assert.equal(bound.provider_account_id,STRIPE_A);assert.equal(bound.provider_payment_id,'pi_A');
    const replayBind=ok(await service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'bind replay');
    assert.equal(replayBind.id,attempt.id);
    await denied(service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_DIFFERENT'}),'bind payment mismatch');
    await denied(service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_A'}),'bind account mismatch');
    pass('Provider binding is tenant-account exact and idempotent; account/payment mismatches fail closed');

    await db.query("UPDATE public.payment_attempts SET reservation_expires_at=now()-interval '1 second' WHERE id=$1",[attempt.id]);
    assert.equal((await db.query('SELECT ting_private.expire_payment_reservations($1,$2) AS n',[A,orderA])).rows[0].n,0);
    assert.equal((await db.query('SELECT status FROM public.payment_attempts WHERE id=$1',[attempt.id])).rows[0].status,'pending');
    const pendingBalance=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'pending balance');
    assert.equal(Number(pendingBalance.amount_reserved),60);assert.equal(Number(pendingBalance.amount_available),40);
    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:50,p_client_request_id:randomUUID()}),'over-reserve against stale pending');
    pass('Expired cleanup threshold never releases processor-bound pending balance without a trusted terminal event');

    await denied(service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_A',p_terminal_status:'failed'}),'release account mismatch');
    await denied(service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_WRONG',p_terminal_status:'failed'}),'release payment mismatch');
    const failed=ok(await service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_terminal_status:'failed',p_failure_code:'card_declined',p_failure_message:'test'}),'trusted release');
    assert.equal(failed.status,'failed');
    const canceledReplay=ok(await service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_terminal_status:'cancelled'}),'terminal replay');
    assert.equal(canceledReplay.status,'failed');
    const releasedBalance=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'released balance');
    assert.equal(Number(releasedBalance.amount_reserved),0);assert.equal(Number(releasedBalance.amount_available),100);
    pass('Trusted release requires canonical Connect account + provider reference and replay is harmless');

    const successAttempt=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:100,p_client_request_id:randomUUID()}),'success attempt');
    ok(await service.rpc('bind_payment_provider',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS'}),'bind success attempt');
    await denied(service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'confirm account mismatch');
    await denied(service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_WRONG',p_confirmed_amount:100,p_currency:'AUD'}),'confirm provider mismatch');
    await denied(service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:99,p_currency:'AUD'}),'confirm amount mismatch');
    const succeeded=ok(await service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'exact confirm');
    assert.equal(succeeded.status,'succeeded');
    const confirmReplay=ok(await service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:successAttempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'confirm replay');
    assert.equal(confirmReplay.id,successAttempt.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[successAttempt.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT payment_status FROM public.orders WHERE id=$1',[orderA])).rows[0].payment_status,'paid');
    pass('Exact Connect confirmation allocates once; account/provider/amount mismatch and replay behavior fail safe');

    const abortOrder=randomUUID();
    await db.query(`INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id)
      VALUES ($1,$2,'ABORT','submitted',50,50,$3)`,[abortOrder,A,randomUUID()]);
    const abortAttempt=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:abortOrder,p_requested_amount:50,p_client_request_id:randomUUID()}),'unbound attempt');
    await denied(visitorA.rpc('abort_created_payment_attempt',{p_attempt_id:abortAttempt.id,p_failure_code:'x'}),'anon abort');
    const aborted=ok(await service.rpc('abort_created_payment_attempt',{p_attempt_id:abortAttempt.id,p_failure_code:'stripe_intent_create_failed',p_failure_message:'test'}),'service abort');
    assert.equal(aborted.status,'failed');assert.equal(aborted.provider_payment_id,null);assert.equal(aborted.provider_account_id,null);
    const abortReplay=ok(await service.rpc('abort_created_payment_attempt',{p_attempt_id:abortAttempt.id,p_failure_code:'again'}),'abort replay');
    assert.equal(abortReplay.id,abortAttempt.id);
    const abortBalance=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:abortOrder}),'abort balance');
    assert.equal(Number(abortBalance.amount_reserved),0);assert.equal(Number(abortBalance.amount_available),50);
    pass('Processor setup failure can immediately release only an unbound created attempt; browser cannot invoke it');
  }finally{
    await Promise.allSettled([visitorA.removeAllChannels(),service.removeAllChannels()]);
  }
}
