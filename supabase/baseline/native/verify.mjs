import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const sorted = x => Array.isArray(x) ? x.map(sorted).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k,sorted(x[k])])) : x;
function check(condition, label) { if (!condition) throw new Error(label); }
function same(a,b,label) { try { assert.deepEqual(a,b); } catch { throw new Error(label); } }
function ok(result,label) { check(!result.error, `${label} failed (code ${String(result.error?.code ?? result.error?.status ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g,'')})`); return result.data; }

export async function verify(status, report, historyRehearsal, releaseRehearsal) {
  for (const key of ['API_URL','DB_URL']) {
    const url = new URL(status[key]);
    check(url.hostname === '127.0.0.1', 'Refusing non-loopback ' + key);
    check(url.port === (key === 'API_URL' ? '54321' : '54322'), 'Unexpected local port');
  }
  check(status.ANON_KEY && status.SERVICE_ROLE_KEY, 'Local legacy API keys unavailable');
  const db = new pg.Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const service = createClient(status.API_URL,status.SERVICE_ROLE_KEY,options);
  const admin = createClient(status.API_URL,status.ANON_KEY,options);
  const visitor = createClient(status.API_URL,status.ANON_KEY,options);
  const ordinary = createClient(status.API_URL,status.ANON_KEY,options);
  const pass = label => { report.checks.push(label); console.log('PASS: ' + label); };
  await db.connect();
  try {
    report.postgres = (await db.query('select version() as v')).rows[0].v;
    check(report.postgres.includes('PostgreSQL 17.'),'Expected native PostgreSQL 17');
    const sql = read('schema.sql');
    try { await db.query(sql); throw new Error('Target guard unexpectedly accepted'); }
    catch(e) { check(/approved-empty-target/.test(e.message),'Explicit target guard failed'); await db.query('ROLLBACK'); }
    pass('Explicit target guard');
    // Do not silently drop inherited triggers or weaken the bootstrap guard.
    const conflicts = await db.query("select evtname from pg_event_trigger where evtname='ensure_rls'");
    check(conflicts.rowCount === 0,'Fresh stack has an ensure_rls conflict; target-specific review required');
    await db.query("SET ting.baseline_replay='approved-empty-target'");
    await db.query(sql);
    pass('Native application bootstrap');
    const actual = (await db.query(read('capture.sql'))).rows[0].snapshot;
    const source = JSON.parse(read('catalog.json'));
    const sections = ['schemas','tables','constraints','indexes','functions','triggers','policies','publications','publication_tables','buckets','event_triggers'];
    report.catalogue_differences = sections.filter(key => JSON.stringify(sorted(actual[key])) !== JSON.stringify(sorted(source[key])));
    check(report.catalogue_differences.length === 0,'Native catalogue mismatch: ' + report.catalogue_differences.join(', '));
    for (const table of source.tables) same(actual.tables.find(t => t.name === table.name && t.schema === table.schema).columns,table.columns,'Column order: ' + table.name);
    same(sorted(actual.default_acls.filter(x => x.owner === 'postgres')),sorted(source.default_acls.filter(x => x.owner === 'postgres')),'Postgres default ACL mismatch');
    check(actual.other_relations === null && actual.custom_types === null,'Unexpected app objects');
    report.extensions = actual.extensions;
    pass('Eleven catalogue sections, column ordering and postgres default ACLs');
    try { await db.query(sql); throw new Error('Nonempty guard unexpectedly accepted'); }
    catch(e) { check(/nonempty application schemas/.test(e.message),'Nonempty target guard failed'); await db.query('ROLLBACK'); }
    pass('Nonempty target guard');
    if(historyRehearsal) {
      await historyRehearsal(db);
      const after = (await db.query(read('capture.sql'))).rows[0].snapshot;
      for(const section of sections) same(sorted(after[section]),sorted(actual[section]),'History rehearsal changed application catalogue: '+section);
      pass('Application catalogue unchanged after forward-deployment rehearsal');
    }
    await db.query("NOTIFY pgrst, 'reload schema'");
    // Wait for PostgREST's asynchronous schema-cache reload, bounded to 10 seconds.
    let ready = false;
    for(let i=0;i<20;i++) {
      const result = await visitor.from('menu_items').select('id').limit(1);
      if(!result.error) { ready=true; break; }
      await new Promise(r => setTimeout(r,500));
    }
    check(ready,'PostgREST schema cache did not become ready');
    const password = randomUUID() + 'Aa1!';
    const email = 'ting-restore-admin@example.com';
    const created = ok(await service.auth.admin.createUser({ email,password,email_confirm:true }),'Create synthetic admin');
    await db.query('insert into public.admin_users(user_id) values ($1)',[created.user.id]);
    ok(await admin.auth.signInWithPassword({email,password}),'Admin password login');
    ok(await service.auth.admin.createUser({email:'ting-restore-user@example.com',password,email_confirm:true}),'Create ordinary user');
    ok(await ordinary.auth.signInWithPassword({email:'ting-restore-user@example.com',password}),'Ordinary password login');
    check(ok(await admin.rpc('is_admin'),'Admin role check') === true,'Admin role rejected');
    check(ok(await ordinary.rpc('is_admin'),'Ordinary role check') === false,'Ordinary user became admin');
    pass('Real Auth login and admin allowlist distinction');
    const tenant = randomUUID();
    const slug = 'restore-test';
    await db.query('insert into public.tenants(id,client_slug) values ($1,$2)',[tenant,slug]);
    const item = ok(await admin.from('menu_items').insert({client_slug:slug,name:'<b>Restore item</b>',price:1}).select().single(),'Admin menu insert');
    check(item.tenant_id === tenant && item.name === 'Restore item','Menu owner or sanitization trigger failed');
    check(ok(await visitor.from('menu_items').select('id').eq('id',item.id),'Anonymous menu read').length === 1,'Anonymous menu missing');
    check((await ordinary.from('menu_items').insert({client_slug:slug,name:'Denied',price:1})).error?.code === '42501','Ordinary menu write was not denied by RLS');
    pass('REST menu access, owner assignment, sanitization and rejected non-admin write');
    const ticketId = randomUUID();
    let receive;
    const delivery = new Promise(resolve => { receive=resolve; });
    // A channel join alone can precede database-stream startup. Wait for the
    // server's postgres_changes confirmation before producing the test event.
    report.realtime_system_events = [];
    const channel = admin.channel('restore-tickets', {config:{postgres_changes_options:{wait:true,timeout:20000}}})
      .on('system', {}, payload => { report.realtime_system_events.push({extension:payload.extension,status:payload.status}); })
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'service_tickets'}, payload => { if(payload.new.id === ticketId) receive(payload.new); });
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('Realtime subscription timeout')),25000);
      channel.subscribe(state => {
        if(state === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if(state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') { clearTimeout(timer); reject(new Error('Realtime subscription failed')); }
      });
    });
    ok(await visitor.from('service_tickets').insert({id:ticketId,client_slug:slug,table_number:'1',request_type:'Assistance'}),'Anonymous ticket create');
    let timer;
    const payload = await Promise.race([delivery,new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('Realtime ticket delivery timeout')),20000); })]).finally(() => clearTimeout(timer));
    check(payload.tenant_id === tenant,'Realtime ticket has wrong owner');
    pass('Realtime authenticated INSERT delivery from anonymous REST write');
    const ticket = ok(await admin.from('service_tickets').select().eq('id',ticketId).single(),'Admin ticket read');
    check(ticket.tenant_id === tenant,'Canonical ticket owner missing');
    check(ok(await ordinary.from('service_tickets').select('id').eq('id',ticketId),'Ordinary ticket read').length === 0,'Ordinary user can read admin ticket');
    const resolved = ok(await admin.from('service_tickets').update({status:'resolved'}).eq('id',ticketId).select().single(),'Admin resolve ticket');
    check(resolved.status === 'resolved','Ticket update affected no row');
    check((await visitor.from('service_tickets').insert({table_number:'1',request_type:'Missing owner'})).error,'Missing owner accepted');
    check((await admin.from('service_tickets').update({tenant_id:randomUUID()}).eq('id',ticketId)).error?.code === '23514','Ownership reassignment accepted');
    pass('Ticket resolution, canonical ownership and rejected ownership changes');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    ok(await admin.storage.from('menu-pictures').upload('restore-test.png',png,{contentType:'image/png'}),'Admin image upload');
    const publicUrl = admin.storage.from('menu-pictures').getPublicUrl('restore-test.png').data.publicUrl;
    check(new URL(publicUrl).origin === new URL(status.API_URL).origin,'Storage URL escaped local stack');
    const response = await fetch(publicUrl,{signal:AbortSignal.timeout(10000)});
    check(response.ok,'Public image HTTP download failed');
    same(Buffer.from(await response.arrayBuffer()),png,'Uploaded image bytes differ');
    check((await ordinary.storage.from('menu-pictures').upload('denied.png',png,{contentType:'image/png'})).error,'Ordinary image upload accepted');
    ok(await admin.storage.from('menu-pictures').remove(['restore-test.png']),'Admin image deletion');
    pass('Real Storage upload, public byte-for-byte download, non-admin denial and deletion');
    if (releaseRehearsal) await releaseRehearsal(db,{admin,ordinary,visitor,service});
  } finally {
    await Promise.allSettled([admin.removeAllChannels(),ordinary.removeAllChannels(),visitor.removeAllChannels(),service.removeAllChannels()]);
    await db.end();
  }
}
