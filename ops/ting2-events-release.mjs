// One reviewed release, fixed source SHA; secrets never printed or exported.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const source = resolve('release');
const cli = join(source, 'supabase/baseline/native/node_modules/.bin/supabase');
const work = mkdtempSync(join(tmpdir(), 'ting-events-prod-'));
const project = 'okrwklulwrfnrhnffbwp';
const releaseSha = '17854ed68ee0b718f1f4bbc77403155f1f4d729f';
const migrationName = '20260922155033_ting2_menu_event_isolation.sql';
const mode = process.env.TING_RELEASE_MODE;
const report = {mode, source: releaseSha, checks: [], production_schema_writes: false};
let stage = 'configuration';

const expectedLedger = [
  ['20260731143616', 'ting_secure_tenant_foundation', '5021f413cb52f49f68f542637999d34a'],
  ['20260801163330', 'ting_harden_security_definer_functions', '0748ebd97be38bbef6eddab636d61453'],
  ['20260801174026', 'ting_seed_internal_demo_tenant_v3', 'fe252a9079813d8216265cc4e6a3b96c'],
  ['20260801181205', 'ting_backfill_internal_demo_history', 'df174a7a0b322bfbce81baca5408c161'],
  ['20260803090652', 'ting_remove_internal_demo_slug_defaults', 'b0e0a2e5e6222922fc75942a0016f6fc'],
  ['20260803120714', 'ting9_service_ticket_ownership_expansion', 'd5d6d31b2099aa3e3071daa867a94058'],
  ['20260805041650', 'ting9_service_ticket_ownership_enforcement', 'ecc9268cddaf23aeba102be44e43bfaf'],
  ['20260805041932', 'ting9_rollback_enforcement_after_upsert_rls_regression', '9c6c00a08b27281e705ad51e01148617'],
  ['20260805042037', 'ting9_reapply_enforcement_after_deployed_writer_confirmation', '85e386a503794fd52dbb65530c72e7f3'],
  ['20260918144301', 'ting2_settings_table_isolation', '8bf8b4181b3396733a160adb392e57b6'],
  ['20260922054639', 'ting2_menu_item_isolation', '8a03634da74dd2c9ac7b4c4579864851'],
].map(([version, name, statements_md5]) => ({version, name, statements_md5}));

function run(args) {
  const result = spawnSync(cli, [...args, '--workdir', work], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = (result.stderr || '') + (result.stdout || '');
    let category = 'CLI command failed';
    if (/password authentication failed/i.test(output)) category = 'database password rejected';
    else if (/invalid.*token|unauthorized|401/i.test(output)) category = 'access token rejected';
    else if (/timeout|timed out/i.test(output)) category = 'connection timeout';
    throw new Error(category);
  }
  return result.stdout;
}

function query(sql) {
  const file = join(work, 'query.sql');
  writeFileSync(file, sql, {mode: 0o600});
  const raw = run(['db', 'query', '--linked', '--file', file, '-o', 'json']);
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.rows)) return parsed.rows;
  throw new Error('Unexpected CLI query result format');
}

const pass = label => report.checks.push(label);
const ledger = () => query(
  `SELECT version,name,md5(array_to_string(statements,chr(10))) AS statements_md5
   FROM supabase_migrations.schema_migrations ORDER BY version`,
);
const eventState = () => query(`
  SELECT
    (SELECT count(*)::int FROM public.menu_events) AS total,
    (SELECT count(*)::int FROM public.menu_events WHERE tenant_id IS NULL) AS unowned,
    (SELECT count(*)::int
       FROM public.menu_events e
       LEFT JOIN public.tenants t ON t.id=e.tenant_id
      WHERE t.id IS NULL OR t.client_slug IS DISTINCT FROM e.client_slug) AS mismatched,
    (SELECT count(*)::int
       FROM public.menu_events e
       JOIN public.menu_items i ON i.id=e.item_id
      WHERE i.tenant_id IS DISTINCT FROM e.tenant_id) AS item_mismatched,
    (SELECT jsonb_agg(ownership ORDER BY ownership->>'tenant_id')
       FROM (SELECT DISTINCT jsonb_build_object(
         'tenant_id',e.tenant_id,'client_slug',e.client_slug
       ) AS ownership FROM public.menu_events e) grouped) AS ownership,
    (SELECT jsonb_agg(policyname ORDER BY policyname)
       FROM pg_policies
      WHERE schemaname='public' AND tablename='menu_events') AS policies,
    (SELECT jsonb_object_agg(grantee, privileges)
       FROM (
         SELECT grantee, jsonb_agg(privilege_type ORDER BY privilege_type) AS privileges
           FROM information_schema.role_table_grants
          WHERE table_schema='public' AND table_name='menu_events'
            AND grantee IN ('anon','authenticated','service_role')
          GROUP BY grantee
       ) grouped_grants) AS grants,
    (SELECT count(*)::int
       FROM pg_publication_tables
      WHERE pubname='supabase_realtime'
        AND schemaname='public' AND tablename='menu_events') AS realtime_membership,
    (SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='menu_events'
        AND column_name='tenant_id') AS tenant_nullable,
    (SELECT count(*)::int
       FROM pg_trigger
      WHERE tgrelid='public.menu_events'::regclass
        AND tgname='menu_events_assign_tenant_id' AND NOT tgisinternal) AS assignment_trigger
`)[0];

try {
  assert(['dry-run', 'apply'].includes(mode), 'Invalid release mode');
  for (const key of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_PROJECT_ID']) {
    assert(process.env[key], key + ' missing');
  }
  assert.equal(process.env.SUPABASE_PROJECT_ID, project, 'Project ID differs from approved target');

  stage = 'initialize';
  run(['init', '--yes']);
  const migrations = join(work, 'supabase/migrations');
  mkdirSync(migrations, {recursive: true});
  for (const filename of readdirSync(join(source, 'supabase/migrations'))) {
    if (/^\d+_.+\.sql$/.test(filename)) {
      copyFileSync(join(source, 'supabase/migrations', filename), join(migrations, filename));
    }
  }
  assert.equal(readdirSync(migrations).length, 12, 'Release directory must contain exactly twelve migrations');

  stage = 'authenticate and link';
  run(['link', '--project-ref', project]);
  pass('Authenticated link to approved project');

  stage = 'history preflight';
  assert.deepEqual(ledger(), expectedLedger, 'Migration history drift');
  pass('Eleven production migration versions, names and fingerprints match');

  stage = 'analytics ownership preflight';
  const before = eventState();
  assert(before.total >= 123, 'Reviewed analytics history was unexpectedly removed');
  assert.equal(before.unowned, 0, 'Unowned analytics row found');
  assert.equal(before.mismatched, 0, 'Analytics tenant and slug mismatch found');
  assert.equal(before.item_mismatched, 0, 'Cross-tenant menu item reference found');
  assert.deepEqual(before.ownership, [{
    tenant_id: 'd8e68393-70de-4e77-8c07-51992f2b64a6',
    client_slug: 'the-bistro',
  }], 'Reviewed analytics ownership changed');
  assert.deepEqual(before.policies, [
    'Admins can delete menu analytics',
    'Admins can read menu analytics',
    'Public can insert menu analytics',
  ]);
  assert.deepEqual(before.grants, {
    anon: ['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'],
    authenticated: ['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'],
    service_role: ['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'],
  });
  assert.equal(before.realtime_membership, 0);
  assert.equal(before.tenant_nullable, 'YES');
  assert.equal(before.assignment_trigger, 1);
  pass('Reviewed analytics rows, policies, grants and publication state match');

  stage = 'membership preflight';
  const owners = query(`
    SELECT count(*)::int AS n
      FROM public.tenant_memberships tm
      JOIN public.tenants t ON t.id=tm.tenant_id
      JOIN auth.users u ON u.id=tm.user_id
     WHERE lower(u.email)=lower('supportyeti.community@gmail.com')
       AND t.client_slug='the-bistro' AND tm.role='owner'
  `)[0];
  assert.equal(owners.n, 1, 'Approved Bistro owner membership changed');
  pass('Approved Bistro owner membership exists');

  stage = 'target dry-run';
  run(['db', 'push', '--linked', '--dry-run', '--skip-vault', '--yes']);
  assert.deepEqual(ledger(), expectedLedger, 'Dry-run changed migration history');
  report.only_pending_migration = migrationName;
  pass('Authenticated production dry-run passed; only reviewed migration is pending');

  if (mode === 'apply') {
    stage = 'apply approved migration';
    run(['db', 'push', '--linked', '--skip-vault', '--yes']);
    report.production_schema_writes = true;

    stage = 'verify release';
    const afterLedger = ledger();
    assert.equal(afterLedger.length, 12);
    assert.deepEqual(afterLedger.slice(0, 11), expectedLedger);
    assert.equal(afterLedger[11].version, '20260922155033');
    assert.equal(afterLedger[11].name, 'ting2_menu_event_isolation');
    const after = eventState();
    assert(after.total >= 123);
    assert.equal(after.unowned, 0);
    assert.equal(after.mismatched, 0);
    assert.equal(after.item_mismatched, 0);
    assert.deepEqual(after.ownership, before.ownership);
    assert.deepEqual(after.policies, [
      'menu_events_member_delete',
      'menu_events_member_read',
      'menu_events_routed_insert',
    ]);
    assert.deepEqual(after.grants, {
      anon: ['INSERT'],
      authenticated: ['DELETE','INSERT','SELECT'],
      service_role: ['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'],
    });
    assert.equal(after.realtime_membership, 0);
    assert.equal(after.tenant_nullable, 'NO');
    assert.equal(after.assignment_trigger, 1);
    pass('Exact migration recorded; analytics ownership, policies, grants and publication verified');
  }

  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL';
  report.stage = stage;
  report.reason = error.code === 'ERR_ASSERTION'
    ? error.message
    : error instanceof SyntaxError
      ? 'CLI did not return expected JSON'
      : error.message;
  process.exitCode = 1;
} finally {
  rmSync(work, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
}
