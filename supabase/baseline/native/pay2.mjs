import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { rehearsePay1 } from './pay1.mjs';

const A='10000000-0000-4000-8000-000000000011';
const B='10000000-0000-4000-8000-000000000012';
const STRIPE_A='acct_ting_test_a';
const STRIPE_WRONG='acct_ting_wrong';
const PAY2='20261015020000_pay2_current_main_recovery.sql';
const TOKEN_A='a'.repeat(64);
// TING-11 already uses 'b'.repeat(64) for Tenant B in the shared rehearsal.
// Keep PAY-2's Tenant-B capability distinct so the fixture respects the
// production UNIQUE (tenant_id, token_hash) invariant rather than weakening it.
const TOKEN_B='d'.repeat(64);
const TOKEN_WRONG='c'.repeat(64);
const sourceSql=()=>readFileSync(new URL('../../migrations/'+PAY2,import.meta.url),'utf8');

export async function rehearsePay2(db,status,report,command,workdir){
  const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};
  await rehearsePay1(db,status,report,command,workdir);

  const migrationDir=join(workdir,'supabase/migrations');
  writeFileSync(join(migrationDir,PAY2),sourceSql());
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  command(['db','push','--local','--skip-vault','--yes']);
  command(['db','push','--local','--skip-vault','--yes']);
  const ledger=(await db.query("SELECT count(*)::int n FROM supabase_migrations.schema_migrations WHERE version='20261015020000'")).rows[0].n;
  assert.equal(ledger,1);
  pass('PAY-2 recovery migration dry-runs, applies once, and repeated push is a no-op');

  const orderA=randomUUID(), orderB=randomUUID();
  await db.query(`INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id)
    VALUES ($1,$3,'PAY2-A','submitted',100,100,$5),($2,$4,'PAY2-B','submitted',80,80,$6)`,
    [orderA,orderB,A,B,randomUUID(),randomUUID()]);
  await db.query(`INSERT INTO public.table_access_contexts(tenant_id,table_number,token_hash)
    VALUES ($1,'PAY2-A',extensions.digest($2,'sha256')),($3,'PAY2-B',extensions.digest($4,'sha256'))`,
    [A,TOKEN_A,B,TOKEN_B]);
  await db.query(`INSERT INTO public.tenant_payment_accounts(tenant_id,provider,provider_account_id,status)
    VALUES ($1,'stripe',$2,'active')`,[A,STRIPE_A]);

  const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
  const client=slug=>createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':slug}}});
  const visitorA=client('order-a'), visitorB=client('order-b');
  const service=createClient(status.API_URL,status.SERVICE_ROLE_KEY,options);
  const ok=(r,label)=>{assert(!r.error,label+': '+(r.error?.code||'unknown'));return Array.isArray(r.data)?r.data[0]:r.data;};
  const denied=async(p,label)=>{const r=await p;assert(r.error,label+' unexpectedly succeeded');return r.error;};

  try {
    let ready=false;
    for(let i=0;i<30;i++){
      const r=await visitorA.rpc('authorize_order_payment_context',{p_order_id:orderA,p_table_token:TOKEN_A});
      if(!r.error||!String(r.error.code||'').startsWith('PGRST')){ready=true;break;}
      await new Promise(x=>setTimeout(x,500));
    }
    assert(ready,'PostgREST PAY-2 recovery RPC cache not ready');

    await denied(visitorA.from('tenant_payment_accounts').select('*'),'anon provider-account read');
    await denied(visitorA.from('tenant_payment_accounts').insert({tenant_id:A,provider:'stripe',provider_account_id:'acct_forged'}),'anon provider-account write');
    pass('Stripe connected-account mapping remains server-managed and browser-inaccessible');

    await denied(visitorA.rpc('authorize_order_payment_context',{p_order_id:orderA,p_table_token:null}),'missing payment capability');
    await denied(visitorA.rpc('authorize_order_payment_context',{p_order_id:orderA,p_table_token:TOKEN_WRONG}),'wrong-table payment capability');
    await denied(visitorB.rpc('authorize_order_payment_context',{p_order_id:orderA,p_table_token:TOKEN_A}),'cross-tenant payment capability');
    const authorized=ok(await visitorA.rpc('authorize_order_payment_context',{p_order_id:orderA,p_table_token:TOKEN_A}),'valid payment capability');
    assert.equal(authorized.tenant_id,A);assert.equal(authorized.order_id,orderA);assert.equal(authorized.table_number,'PAY2-A');
    pass('Payment context is bound to route + canonical order table + bearer capability');

    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:randomUUID(),p_table_token:null}),'attempt missing token');
    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:randomUUID(),p_table_token:TOKEN_WRONG}),'attempt wrong token');
    await denied(visitorB.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:randomUUID(),p_table_token:TOKEN_A}),'attempt cross tenant');

    const req1=randomUUID();
    const attempt=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:req1,p_table_token:TOKEN_A}),'valid payment attempt');
    assert.equal(attempt.tenant_id,A);assert.equal(attempt.order_id,orderA);
    const replay=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:1,p_client_request_id:req1,p_table_token:TOKEN_A}),'idempotent payment retry');
    assert.equal(replay.id,attempt.id);
    pass('Capability-bound payment reservation remains idempotent');

    await denied(visitorA.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'anon provider bind');
    await denied(visitorA.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_terminal_status:'failed'}),'anon provider release');
    await denied(visitorA.rpc('confirm_payment_attempt_trusted',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_confirmed_amount:60,p_currency:'AUD'}),'anon trusted confirm');
    pass('Processor binding, release and confirmation remain service-role-only');

    await denied(service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_A'}),'unknown connected account');
    const bound=ok(await service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'service provider bind');
    assert.equal(bound.status,'pending');assert.equal(bound.provider_account_id,STRIPE_A);
    const boundReplay=ok(await service.rpc('bind_payment_provider',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A'}),'provider bind replay');
    assert.equal(boundReplay.id,attempt.id);
    pass('Connected-account binding is exact and idempotent');

    await db.query("UPDATE public.payment_attempts SET reservation_expires_at=now()-interval '1 second' WHERE id=$1",[attempt.id]);
    assert.equal((await db.query('SELECT ting_private.expire_payment_reservations($1,$2) AS n',[A,orderA])).rows[0].n,0);
    const pending=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'pending processor balance');
    assert.equal(Number(pending.amount_reserved),60);assert.equal(Number(pending.amount_available),40);
    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:50,p_client_request_id:randomUUID(),p_table_token:TOKEN_A}),'over-reserve with pending processor attempt');
    pass('Processor-bound pending balance never auto-releases on cleanup timeout');

    await denied(service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_A',p_terminal_status:'failed'}),'release account mismatch');
    const failed=ok(await service.rpc('release_payment_attempt',{p_attempt_id:attempt.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_A',p_terminal_status:'failed'}),'trusted terminal release');
    assert.equal(failed.status,'failed');
    const released=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'released balance');
    assert.equal(Number(released.amount_reserved),0);assert.equal(Number(released.amount_available),100);
    pass('Trusted terminal release requires canonical processor account/reference');

    const success=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:100,p_client_request_id:randomUUID(),p_table_token:TOKEN_A}),'success payment attempt');
    ok(await service.rpc('bind_payment_provider',{p_attempt_id:success.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS'}),'bind success attempt');
    await denied(service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:success.id,p_provider:'stripe',p_provider_account_id:STRIPE_WRONG,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'confirm account mismatch');
    const succeeded=ok(await service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:success.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'exact trusted confirm');
    assert.equal(succeeded.status,'succeeded');
    const confirmReplay=ok(await service.rpc('confirm_payment_attempt_trusted',{p_attempt_id:success.id,p_provider:'stripe',p_provider_account_id:STRIPE_A,p_provider_payment_id:'pi_SUCCESS',p_confirmed_amount:100,p_currency:'AUD'}),'confirm replay');
    assert.equal(confirmReplay.id,success.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[success.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT payment_status FROM public.orders WHERE id=$1',[orderA])).rows[0].payment_status,'paid');
    pass('Exact Stripe confirmation allocates once; mismatch and replay remain fail-safe');

    const abortOrder=randomUUID();
    await db.query(`INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id)
      VALUES ($1,$2,'PAY2-A','submitted',50,50,$3)`,[abortOrder,A,randomUUID()]);
    const abortAttempt=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:abortOrder,p_requested_amount:50,p_client_request_id:randomUUID(),p_table_token:TOKEN_A}),'unbound attempt');
    await denied(visitorA.rpc('abort_created_payment_attempt',{p_attempt_id:abortAttempt.id,p_failure_code:'x'}),'anon abort');
    const aborted=ok(await service.rpc('abort_created_payment_attempt',{p_attempt_id:abortAttempt.id,p_failure_code:'stripe_intent_create_failed',p_failure_message:'test'}),'service abort');
    assert.equal(aborted.status,'failed');assert.equal(aborted.provider_payment_id,null);assert.equal(aborted.provider_account_id,null);
    pass('Processor setup failure can release only an unbound created attempt; browser cannot invoke it');
  } finally {
    await Promise.allSettled([visitorA.removeAllChannels(),visitorB.removeAllChannels(),service.removeAllChannels()]);
  }
}
