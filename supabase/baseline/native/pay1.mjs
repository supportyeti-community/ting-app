import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { rehearseTing11 } from './ting11.mjs';

const A='10000000-0000-4000-8000-000000000011';
const B='10000000-0000-4000-8000-000000000012';
const PAY1='20261008110500_pay1_payment_foundation.sql';
const sourceSql=()=>new URL('../../migrations/'+PAY1,import.meta.url);

export async function rehearsePay1(db,status,report,command,workdir){
  const pass=label=>{report.checks.push(label);console.log('PASS: '+label);};

  // Reuse the already-certified ordering rehearsal so PAY-1 is always exercised
  // on top of the complete canonical release chain and tenant boundary.
  await rehearseTing11(db,status,report,command,workdir);

  const migrationDir=join(workdir,'supabase/migrations');
  const sql=(await import('node:fs')).readFileSync(sourceSql(),'utf8');
  writeFileSync(join(migrationDir,PAY1),sql);
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  command(['db','push','--local','--skip-vault','--yes']);
  command(['db','push','--local','--skip-vault','--yes']);
  const ledger=(await db.query("SELECT count(*)::int n FROM supabase_migrations.schema_migrations WHERE version='20261008110500'")).rows[0].n;
  assert.equal(ledger,1);
  pass('PAY-1 migration dry-runs, applies once, and repeated push is a no-op');

  const orderA=randomUUID(), orderB=randomUUID();
  await db.query(`INSERT INTO public.orders(id,tenant_id,table_number,status,subtotal,total,client_request_id)
    VALUES ($1,$3,'P1','submitted',100,100,$5),($2,$4,'P2','submitted',80,80,$6)`,
    [orderA,orderB,A,B,randomUUID(),randomUUID()]);

  const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
  const client=slug=>createClient(status.API_URL,status.ANON_KEY,{...options,global:{headers:{'x-client-slug':slug}}});
  const visitorA=client('order-a'),visitorB=client('order-b');
  const ok=(r,label)=>{assert(!r.error,label+': '+(r.error?.code||'unknown'));return Array.isArray(r.data)?r.data[0]:r.data;};
  const denied=async(p,label)=>{const r=await p;assert(r.error,label+' unexpectedly succeeded');return r.error;};

  try {
    let ready=false;
    for(let i=0;i<30;i++){
      const r=await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA});
      if(!r.error||!String(r.error.code||'').startsWith('PGRST')){ready=true;break;}
      await new Promise(x=>setTimeout(x,500));
    }
    assert(ready,'PostgREST PAY-1 RPC cache not ready');

    assert((await visitorA.from('payment_attempts').insert({tenant_id:A,order_id:orderA,client_request_id:randomUUID(),requested_amount:1,reservation_expires_at:new Date(Date.now()+60000).toISOString()})).error);
    assert((await visitorA.from('payment_allocations').insert({tenant_id:A,order_id:orderA,payment_attempt_id:randomUUID(),amount:1})).error);
    pass('Customer cannot directly write payment attempts or allocations');

    const initial=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'initial balance');
    assert.equal(Number(initial.order_total),100);assert.equal(Number(initial.amount_paid),0);assert.equal(Number(initial.amount_reserved),0);assert.equal(Number(initial.amount_due),100);assert.equal(Number(initial.amount_available),100);assert.equal(initial.payment_status,'unpaid');
    await denied(visitorA.rpc('get_order_payment_balance',{p_order_id:orderB}),'cross-tenant balance read');
    pass('Route owns payment balance visibility and cross-tenant order IDs fail closed');

    const req1=randomUUID();
    const attempt1=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:60,p_client_request_id:req1}),'create first reservation');
    assert.equal(Number(attempt1.requested_amount),60);assert.equal(attempt1.tenant_id,A);assert.equal(attempt1.order_id,orderA);
    const afterFirst=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'balance after reservation');
    assert.equal(Number(afterFirst.amount_reserved),60);assert.equal(Number(afterFirst.amount_available),40);
    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:50,p_client_request_id:randomUUID()}),'over-reserve second device');
    const attempt2=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:40,p_client_request_id:randomUUID()}),'reserve exact remainder');
    assert.equal(Number(attempt2.requested_amount),40);
    const fullyReserved=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'fully reserved');
    assert.equal(Number(fullyReserved.amount_reserved),100);assert.equal(Number(fullyReserved.amount_available),0);assert.equal(Number(fullyReserved.amount_due),100);
    pass('Concurrent reservations cannot exceed the currently available order balance');

    const retry=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:1,p_client_request_id:req1}),'idempotent retry');
    assert.equal(retry.id,attempt1.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_attempts WHERE tenant_id=$1 AND client_request_id=$2',[A,req1])).rows[0].n,1);
    pass('Payment attempt retries reuse the canonical attempt idempotently');

    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderB,p_requested_amount:1,p_client_request_id:randomUUID()}),'cross-tenant attempt');
    await denied(visitorB.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:1,p_client_request_id:randomUUID()}),'opposite cross-tenant attempt');
    pass('Cross-tenant payment attempt creation fails closed');

    // Expire the second reservation to prove abandoned attempts free balance.
    await db.query("UPDATE public.payment_attempts SET reservation_expires_at=now()-interval '1 second' WHERE id=$1",[attempt2.id]);
    const req3=randomUUID();
    const replacement=ok(await visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:40,p_client_request_id:req3}),'replacement after expiry');
    assert.equal(Number(replacement.requested_amount),40);
    assert.equal((await db.query('SELECT status FROM public.payment_attempts WHERE id=$1',[attempt2.id])).rows[0].status,'expired');
    pass('Expired abandoned reservations release balance for another diner');

    // Trusted server confirmation: first 60 succeeds and allocates exactly once.
    await db.query("SELECT ting_private.confirm_payment_attempt($1,'test','pay_1',60,'AUD')",[attempt1.id]);
    let balance=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'after first confirmation');
    assert.equal(Number(balance.amount_paid),60);assert.equal(Number(balance.amount_reserved),40);assert.equal(Number(balance.amount_due),40);assert.equal(Number(balance.amount_available),0);assert.equal(balance.payment_status,'partially_paid');
    assert.equal((await db.query('SELECT payment_status FROM public.orders WHERE id=$1',[orderA])).rows[0].payment_status,'partially_paid');
    assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[attempt1.id])).rows[0].n,1);

    // Exact replay must be a no-op, mismatch must fail.
    await db.query("SELECT ting_private.confirm_payment_attempt($1,'test','pay_1',60,'AUD')",[attempt1.id]);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.payment_allocations WHERE payment_attempt_id=$1',[attempt1.id])).rows[0].n,1);
    let mismatch=false;try{await db.query("SELECT ting_private.confirm_payment_attempt($1,'test','pay_DIFFERENT',60,'AUD')",[attempt1.id]);}catch(e){mismatch=e.code==='23514';}assert(mismatch);
    pass('Trusted confirmation allocates exactly once; replay is safe and mismatches fail closed');

    await db.query("SELECT ting_private.confirm_payment_attempt($1,'test','pay_2',40,'AUD')",[replacement.id]);
    balance=ok(await visitorA.rpc('get_order_payment_balance',{p_order_id:orderA}),'fully paid balance');
    assert.equal(Number(balance.amount_paid),100);assert.equal(Number(balance.amount_due),0);assert.equal(balance.payment_status,'paid');
    assert.equal((await db.query('SELECT payment_status FROM public.orders WHERE id=$1',[orderA])).rows[0].payment_status,'paid');
    await denied(visitorA.rpc('create_payment_attempt',{p_order_id:orderA,p_requested_amount:1,p_client_request_id:randomUUID()}),'attempt after fully paid');
    pass('Successful split allocations derive partially_paid then paid and prevent further payment');

    // Structural tenant coupling rejects child drift even with direct SQL.
    let fk=false;try{await db.query("UPDATE public.payment_attempts SET tenant_id=$1 WHERE id=$2",[B,attempt1.id]);}catch(e){fk=e.code==='23503';}assert(fk);
    pass('Composite tenant/order coupling structurally blocks payment tenant drift');
  } finally {
    await Promise.allSettled([visitorA.removeAllChannels(),visitorB.removeAllChannels()]);
  }
}
