// Local rehearsal only: recover baseline history, then exercise the real CLI.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const baseline = fileURLToPath(new URL('..', import.meta.url));
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const md5 = text => createHash('md5').update(text).digest('hex');
export function historicalFiles() {
  const manifest = JSON.parse(readFileSync(join(baseline,'migration-history.json'),'utf8'));
  return manifest.map(row => {
    const filename = `${row.version}_${row.name}.sql`;
    const sql = readFileSync(join(migrations,filename),'utf8');
    assert.equal(md5(sql),row.statements_md5,'Historical migration fingerprint mismatch: ' + row.version);
    return {...row,filename,sql};
  });
}

export async function rehearseHistory(db,report,command,workdir) {
  const files = historicalFiles();
  const pass = label => { report.checks.push(label); console.log('PASS: '+label); };
  const directory = join(workdir,'supabase/migrations');
  mkdirSync(directory,{recursive:true});
  // verify() already checked the CLI-generated loopback endpoint and exact
  // restored catalogue. This callback cannot be invoked with a cloud URL.
  assert.equal((await db.query('select count(*)::int as n from supabase_migrations.schema_migrations')).rows[0].n,0,'Local history must be empty');
  await db.query('BEGIN');
  try {
    for(const row of files) {
      await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3)',[row.version,row.name,[row.sql]]);
      writeFileSync(join(directory,row.filename),row.sql);
    }
    await db.query('COMMIT');
  } catch(e) { await db.query('ROLLBACK'); throw e; }
  const ledger = async () => (await db.query("select version,name,md5(array_to_string(statements,E'\\n')) as statements_md5 from supabase_migrations.schema_migrations order by version")).rows;
  const original = await ledger();
  assert.deepEqual(original,files.map(({version,name,statements_md5})=>({version,name,statements_md5})));
  pass('Nine recovered historical files and local ledger fingerprints match');
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),original,'Baseline-only push changed history');
  pass('Baseline-only CLI dry-run and push are no-ops');

  const hidden = join(directory,files[0].filename);
  renameSync(hidden,hidden+'.withheld');
  try {
    let rejected=false;
    try {command(['db','push','--local','--dry-run','--skip-vault','--yes']);} catch {rejected=true;}
    assert(rejected,'CLI accepted missing historical file');
  } finally {renameSync(hidden+'.withheld',hidden);}
  assert.deepEqual(await ledger(),original,'Rejected dry-run changed history');
  pass('CLI rejects a missing historical version without changing the ledger');

  const newMigration = async (name,sql) => {
    // CLI owns timestamp generation; spacing avoids timestamp collisions.
    await new Promise(r=>setTimeout(r,1100));
    const before = new Set(readdirSync(directory));
    command(['migration','new',name]);
    const added = readdirSync(directory).filter(f=>!before.has(f));
    assert.equal(added.length,1,'Expected one CLI-generated migration');
    writeFileSync(join(directory,added[0]),sql);
    return added[0].split('_')[0];
  };
  const version = await newMigration('ting_forward_rehearsal',
    'BEGIN; CREATE TABLE ting_private.__ting_forward_probe(id integer PRIMARY KEY); ALTER TABLE ting_private.__ting_forward_probe ENABLE ROW LEVEL SECURITY; COMMIT;\n');
  command(['db','push','--local','--dry-run','--skip-vault','--yes']);
  assert.equal((await db.query("select to_regclass('ting_private.__ting_forward_probe') as object")).rows[0].object,null,'Dry-run applied DDL');
  assert.deepEqual(await ledger(),original,'Dry-run wrote history');
  command(['db','push','--local','--skip-vault','--yes']);
  assert((await db.query("select to_regclass('ting_private.__ting_forward_probe') as object")).rows[0].object,'Forward migration not applied');
  assert((await ledger()).some(r=>r.version===version),'Forward migration not recorded');
  const applied = await ledger();
  command(['db','push','--local','--skip-vault','--yes']);
  assert.deepEqual(await ledger(),applied,'Second push reapplied a migration');
  pass('CLI-generated forward migration: dry-run, apply and idempotent second push');

  const failedVersion = await newMigration('ting_failure_rehearsal',
    'BEGIN; CREATE TABLE ting_private.__ting_failed_probe(id integer); SELECT 1/0; COMMIT;\n');
  let failed=false;
  try {command(['db','push','--local','--skip-vault','--yes']);} catch {failed=true;}
  assert(failed,'Deliberately failing migration succeeded');
  assert.equal((await db.query("select to_regclass('ting_private.__ting_failed_probe') as object")).rows[0].object,null,'Failed migration left DDL behind');
  assert.deepEqual(await ledger(),applied,'Failed migration changed the ledger');
  const failedFilename = readdirSync(directory).find(f=>f.startsWith(failedVersion+'_'));
  writeFileSync(join(directory,failedFilename),'BEGIN; DROP TABLE ting_private.__ting_forward_probe; COMMIT;\n');
  command(['db','push','--local','--skip-vault','--yes']);
  assert.equal((await db.query("select to_regclass('ting_private.__ting_forward_probe') as object")).rows[0].object,null,'Cleanup migration failed');
  const final = await ledger();
  assert.deepEqual(final.filter(r=>r.version<=files.at(-1).version),original,'Historical ledger changed during rehearsal');
  assert.equal(final.length,original.length+2,'Unexpected migration ledger entries');
  pass('Failed migration rolls back DDL/history; corrected pending migration succeeds');
  report.history_adoption = {historical_versions:files.map(r=>r.version),method:'Snapshot restore plus exact historical ledger on disposable local database; historical SQL not re-executed',production_history_writes:0,probe_versions:[version,failedVersion]};
}
