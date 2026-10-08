import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { historicalFiles } from './history.mjs';

const A = '10000000-0000-4000-8000-000000000011';
const B = '10000000-0000-4000-8000-000000000012';
const ITEM_A = '30000000-0000-4000-8000-000000000011';
const ITEM_PROMO = '30000000-0000-4000-8000-000000000012';
const ITEM_OUT = '30000000-0000-4000-8000-000000000013';
const ITEM_B = '30000000-0000-4000-8000-000000000014';

const releaseFiles = [
  '20260918144301_ting2_settings_table_isolation.sql',
  '20260922054639_ting2_menu_item_isolation.sql',
  '20260922155033_ting2_menu_event_isolation.sql',
  '20260923101432_ting2_service_ticket_authorization.sql',
  '20260923113515_ting2_routing_registry_prepare.sql',
  '20260923132307_ting2_route_scope_registry.sql',
  '20260923200127_ting4_restrict_menu_picture_listing.sql',
  '20260925013625_ting4_scope_menu_picture_writes.sql',
  '20260925093356_ting8_admin_membership_gate.sql',
  '20260930030209_ting6_harden_sanitize_text_search_path.sql',
  '20261008074200_ting11_ordering_foundation.sql',
  '20261008075500_ting11_order_item_tenant_coupling.sql',
];

const sourceSql = name => readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8');

export async function rehearseTing11(db, status, report, command, workdir) {
  const pass = label => { report.checks.push(label); console.log('PASS: ' + label); };
  const directory = join(workdir, 'supabase/migrations');
  mkdirSync(directory, { recursive: true });

  const history = historicalFiles();
  for (const f of history) writeFileSync(join(directory, f.filename), f.sql);
  command(['migration', 'repair', ...history.map(r => r.version), '--local', '--status', 'applied']);
  for (const f of history) {
    await db.query(
      'UPDATE supabase_migrations.schema_migrations SET name=$2,statements=$3 WHERE version=$1',
      [f.version, f.name, [f.sql]]
    );
  }

  const ledger = async () => (await db.query(
    "SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version"
  )).rows;
  let currentLedger = await ledger();

  for (const name of releaseFiles) {
    writeFileSync(join(directory, name), sourceSql(name));
    command(['db', 'push', '--local', '--dry-run', '--skip-vault', '--yes']);
    assert.deepEqual(await ledger(), currentLedger, 'dry-run changed migration history before ' + name);
    try {
      command(['db', 'push', '--local', '--skip-vault', '--yes']);
    } catch {
      throw new Error('Release migration failed: ' + name);
    }
    const applied = await ledger();
    assert.equal(applied.length, currentLedger.length + 1, 'unexpected ledger growth after ' + name);
    assert.equal(applied.at(-1).version, name.split('_')[0], 'wrong migration recorded for ' + name);
    currentLedger = applied;
  }
  command(['db', 'push', '--local', '--skip-vault', '--yes']);
  assert.deepEqual(await ledger(), currentLedger, 'second TING-11 release-chain push was not a no-op');
  pass('Current release chain + TING-11 migrations dry-run/apply individually and repeated no-op');

  await db.query(
    `INSERT INTO public.tenants(id,client_slug) VALUES ($1,'order-a'),($2,'order-b')`,
    [A, B]
  );
  await db.query(
    `INSERT INTO public.menu_items(id,tenant_id,client_slug,name,price,is_promo,promo_price,is_out_of_stock,sort_order)
     VALUES
       ($1,$5,'order-a','Authoritative A',12.50,false,NULL,false,1),
       ($2,$5,'order-a','Promo A',10.00,true,8.00,false,2),
       ($3,$5,'order-a','Out A',4.00,false,NULL,true,3),
       ($4,$6,'order-b','Foreign B',6.00,false,NULL,false,1)`,
    [ITEM_A, ITEM_PROMO, ITEM_OUT, ITEM_B, A, B]
  );

  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const visitorA = createClient(status.API_URL, status.ANON_KEY, {
    ...options,
    global: { headers: { 'x-client-slug': 'order-a' } }
  });
  const visitorB = createClient(status.API_URL, status.ANON_KEY, {
    ...options,
    global: { headers: { 'x-client-slug': 'order-b' } }
  });
  const adminA = createClient(status.API_URL, status.ANON_KEY, {
    ...options,
    global: { headers: { 'x-client-slug': 'order-b' } }
  });

  const ok = (r, label) => { assert(!r.error, label + ': ' + (r.error?.code || 'unknown')); return r.data; };
  const denied = async (promise, label) => {
    const r = await promise;
    assert(r.error, label + ' unexpectedly succeeded');
    return r.error;
  };
  const scalarRow = data => Array.isArray(data) ? data[0] : data;

  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const r = await visitorA.rpc('submit_order', {
        p_table_number: '1',
        p_client_request_id: randomUUID(),
        p_items: [{ menu_item_id: ITEM_OUT, quantity: 1 }]
      });
      if (!r.error || !String(r.error.code || '').startsWith('PGRST')) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(ready, 'PostgREST TING-11 RPC schema cache not ready');

    assert((await visitorA.from('orders').insert({
      tenant_id: A, table_number: '1', status: 'submitted', subtotal: 0, total: 0, client_request_id: randomUUID()
    })).error, 'anonymous direct order insert must be denied');
    assert((await visitorA.from('order_items').insert({
      tenant_id: A, order_id: randomUUID(), menu_item_id: ITEM_A, item_name_snapshot: 'x', unit_price_snapshot: 1, quantity: 1, line_total: 1
    })).error, 'anonymous direct order-item insert must be denied');
    assert((await visitorA.from('orders').select('id')).error, 'anonymous order reads must be denied');
    pass('Anon direct table reads/writes are denied; customer ordering is RPC-only');

    const requestId = randomUUID();
    const payload = [
      { menu_item_id: ITEM_A, quantity: 2, price: 0.01, total: 0.02, tenant_id: B, name: 'forged' },
      { menu_item_id: ITEM_PROMO, quantity: 1, price: 0.01 }
    ];
    const submitted = scalarRow(ok(await visitorA.rpc('submit_order', {
      p_table_number: ' 12 ',
      p_client_request_id: requestId,
      p_items: payload
    }), 'submit routed order'));
    assert(submitted?.id, 'submit_order did not return an order id');

    const stored = (await db.query(
      'SELECT tenant_id,table_number,status,subtotal,total FROM public.orders WHERE id=$1',
      [submitted.id]
    )).rows[0];
    assert.equal(stored.tenant_id, A);
    assert.equal(stored.table_number, '12');
    assert.equal(stored.status, 'submitted');
    assert.equal(Number(stored.subtotal), 33);
    assert.equal(Number(stored.total), 33);

    const lines = (await db.query(
      'SELECT menu_item_id,item_name_snapshot,unit_price_snapshot,quantity,line_total FROM public.order_items WHERE order_id=$1 ORDER BY menu_item_id',
      [submitted.id]
    )).rows;
    assert.equal(lines.length, 2);
    const regular = lines.find(r => r.menu_item_id === ITEM_A);
    const promo = lines.find(r => r.menu_item_id === ITEM_PROMO);
    assert.equal(regular.item_name_snapshot, 'Authoritative A');
    assert.equal(Number(regular.unit_price_snapshot), 12.5);
    assert.equal(regular.quantity, 2);
    assert.equal(Number(regular.line_total), 25);
    assert.equal(promo.item_name_snapshot, 'Promo A');
    assert.equal(Number(promo.unit_price_snapshot), 8);
    assert.equal(Number(promo.line_total), 8);
    pass('Route owns tenant; database ignores forged price/name/tenant fields and snapshots authoritative menu pricing');

    const retried = scalarRow(ok(await visitorA.rpc('submit_order', {
      p_table_number: '99',
      p_client_request_id: requestId,
      p_items: [{ menu_item_id: ITEM_A, quantity: 1 }]
    }), 'idempotent retry'));
    assert.equal(retried.id, submitted.id);
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM public.orders WHERE tenant_id=$1 AND client_request_id=$2',[A,requestId])).rows[0].n), 1);
    assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM public.order_items WHERE order_id=$1',[submitted.id])).rows[0].n), 2);
    pass('Same tenant/client_request_id retry returns the original order without duplicate lines');

    await denied(visitorA.rpc('submit_order', {
      p_table_number: '12', p_client_request_id: randomUUID(), p_items: [{ menu_item_id: ITEM_B, quantity: 1 }]
    }), 'cross-tenant menu item');
    await denied(visitorA.rpc('submit_order', {
      p_table_number: '12', p_client_request_id: randomUUID(), p_items: [{ menu_item_id: ITEM_OUT, quantity: 1 }]
    }), 'out-of-stock menu item');
    await denied(visitorA.rpc('submit_order', {
      p_table_number: 'table!bad', p_client_request_id: randomUUID(), p_items: [{ menu_item_id: ITEM_A, quantity: 1 }]
    }), 'invalid table context');
    pass('Cross-tenant items, out-of-stock items, and malformed table context fail closed');

    const bOrder = scalarRow(ok(await visitorB.rpc('submit_order', {
      p_table_number: '2', p_client_request_id: randomUUID(), p_items: [{ menu_item_id: ITEM_B, quantity: 1 }]
    }), 'tenant B order'));
    assert.equal((await db.query('SELECT tenant_id FROM public.orders WHERE id=$1',[bOrder.id])).rows[0].tenant_id, B);

    let fkRejected = false;
    try {
      await db.query(
        `INSERT INTO public.order_items(tenant_id,order_id,menu_item_id,item_name_snapshot,unit_price_snapshot,quantity,line_total)
         VALUES ($1,$2,$3,'cross',6,1,6)`,
        [B, submitted.id, ITEM_B]
      );
    } catch (e) {
      fkRejected = e.code === '23503';
    }
    assert(fkRejected, 'composite parent-order tenant foreign key did not reject cross-tenant child');
    pass('Database constraint prevents order-item tenant drift even under privileged direct SQL');

    await denied(visitorA.rpc('advance_order_status', { p_order_id: submitted.id, p_next_status: 'accepted' }), 'anon status advance');

    const email = 'ting11-' + randomUUID() + '@example.com';
    const password = randomUUID() + 'Aa1!';
    const user = ok(await service.auth.admin.createUser({ email, password, email_confirm: true }), 'create tenant A admin').user;
    await db.query('INSERT INTO public.tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)', [A, user.id, 'owner']);
    ok(await adminA.auth.signInWithPassword({ email, password }), 'tenant A admin login');

    const visibleOrders = ok(await adminA.from('orders').select('id,tenant_id'), 'member order read');
    assert(visibleOrders.length >= 1 && visibleOrders.every(row => row.tenant_id === A));
    assert(!visibleOrders.some(row => row.id === bOrder.id), 'tenant A member saw tenant B order');
    const visibleItems = ok(await adminA.from('order_items').select('tenant_id'), 'member item read');
    assert(visibleItems.length >= 2 && visibleItems.every(row => row.tenant_id === A));
    pass('Authenticated membership, not routed slug, controls order/order-item visibility');

    await denied(adminA.rpc('advance_order_status', { p_order_id: submitted.id, p_next_status: 'ready' }), 'invalid status jump');
    for (const next of ['accepted', 'preparing', 'ready', 'completed']) {
      const advanced = scalarRow(ok(await adminA.rpc('advance_order_status', { p_order_id: submitted.id, p_next_status: next }), 'advance to ' + next));
      assert.equal(advanced.status, next);
    }
    await denied(adminA.rpc('advance_order_status', { p_order_id: submitted.id, p_next_status: 'accepted' }), 'completed order reversal');
    const finished = (await db.query('SELECT accepted_at,preparing_at,ready_at,completed_at FROM public.orders WHERE id=$1',[submitted.id])).rows[0];
    assert(finished.accepted_at && finished.preparing_at && finished.ready_at && finished.completed_at, 'status timestamps incomplete');
    pass('Only submitted -> accepted -> preparing -> ready -> completed is allowed; lifecycle timestamps are recorded');

    const revokeOrder = scalarRow(ok(await visitorA.rpc('submit_order', {
      p_table_number: '8', p_client_request_id: randomUUID(), p_items: [{ menu_item_id: ITEM_A, quantity: 1 }]
    }), 'revocation test order'));
    await db.query('DELETE FROM public.tenant_memberships WHERE user_id=$1', [user.id]);
    assert.equal(ok(await adminA.from('orders').select('id'), 'revoked order read').length, 0);
    await denied(adminA.rpc('advance_order_status', { p_order_id: revokeOrder.id, p_next_status: 'accepted' }), 'revoked membership status advance');
    pass('Membership revocation immediately removes order visibility and lifecycle authority');
  } finally {
    await Promise.allSettled([
      service.removeAllChannels(), visitorA.removeAllChannels(), visitorB.removeAllChannels(), adminA.removeAllChannels()
    ]);
  }
}
