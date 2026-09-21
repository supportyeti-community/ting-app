// One reviewed release, fixed source SHA; secrets never printed or exported.
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=resolve('release');
const cli=join(source,'supabase/baseline/native/node_modules/.bin/supabase');
const work=mkdtempSync(join(tmpdir(),'ting-prod-'));
const project='okrwklulwrfnrhnffbwp';
const name='20260918144301_ting2_settings_table_isolation.sql';
const mode=process.env.TING_RELEASE_MODE;
const report={mode,source:'b2f91c47bd3b2800b324005bab163a0bf22f8b56',checks:[],production_schema_writes:false};
let stage='configuration';
const canonical=x=>Array.isArray(x)?x.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
function run(args){const r=spawnSync(cli,[...args,'--workdir',work],{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});if(r.status!==0){const output=(r.stderr||'')+(r.stdout||'');let category='CLI command failed';if(/password authentication failed/i.test(output))category='database password rejected';else if(/invalid.*token|unauthorized|401/i.test(output))category='access token rejected';else if(/timeout|timed out/i.test(output))category='connection timeout';throw new Error(category);}return r.stdout;}
function query(sql){writeFileSync(join(work,'query.sql'),sql,{mode:0o600});const raw=run(['db','query','--linked','--file',join(work,'query.sql'),'-o','json']);const parsed=JSON.parse(raw);if(Array.isArray(parsed))return parsed;if(Array.isArray(parsed.rows))return parsed.rows;throw new Error('Unexpected CLI query result format');}
const pass=label=>report.checks.push(label);
try {
 assert(['dry-run','apply'].includes(mode),'Invalid release mode');
 for(const key of ['SUPABASE_ACCESS_TOKEN','SUPABASE_DB_PASSWORD','SUPABASE_PROJECT_ID'])assert(process.env[key],key+' missing');
 assert.equal(process.env.SUPABASE_PROJECT_ID,project,'Project ID differs from approved target');
 stage='initialize';run(['init','--yes']);mkdirSync(join(work,'supabase/migrations'),{recursive:true});
 const history=JSON.parse(readFileSync(join(source,'supabase/baseline/migration-history.json'),'utf8'));
 for(const row of history)copyFileSync(join(source,'supabase/migrations',`${row.version}_${row.name}.sql`),join(work,'supabase/migrations',`${row.version}_${row.name}.sql`));
 copyFileSync(join(source,'supabase/migrations',name),join(work,'supabase/migrations',name));
 stage='authenticate and link';run(['link','--project-ref',project]);pass('Authenticated link to approved project');
 stage='schema preflight';const actual=query(readFileSync(join(source,'supabase/baseline/capture.sql'),'utf8'))[0].snapshot;
 const expected=JSON.parse(readFileSync(join(source,'supabase/baseline/catalog.json'),'utf8'));
 const diff=Object.keys(expected).filter(k=>k!=='captured_at'&&JSON.stringify(canonical(actual[k]))!==JSON.stringify(canonical(expected[k])));
 assert.deepEqual(diff,[],'Unexpected baseline drift');
 for(const table of expected.tables)assert.deepEqual(actual.tables.find(t=>t.schema===table.schema&&t.name===table.name).columns,table.columns,'Column order drift');
 pass('Complete live application catalogue equals reviewed baseline');
 stage='history preflight';const ledger=query('SELECT version,name,md5(array_to_string(statements,chr(10))) AS statements_md5 FROM supabase_migrations.schema_migrations ORDER BY version');
 assert.deepEqual(ledger,history,'Migration history drift');pass('Nine historical versions/names/fingerprints match');
 stage='data preflight';const counts=query('SELECT (SELECT count(*)::int FROM public.restaurant_settings) AS settings, (SELECT count(*)::int FROM public.table_configurations) AS links, (SELECT count(*)::int FROM public.tenant_memberships) AS memberships')[0];
 assert.equal(counts.settings,0,'Settings no longer empty');assert.equal(counts.links,0,'Links no longer empty');
 assert.equal(counts.memberships,mode==='apply'?1:0,'Membership precondition changed');
 pass('Expected empty settings/links and membership count');
 stage='target dry-run';const dry=run(['db','push','--linked','--dry-run','--skip-vault','--yes']);
 // CLI may write its human-readable plan to stderr. Exact baseline ledger and
 // the isolated ten-file directory establish the only pending release version.
 const unchanged=query('SELECT version,name,md5(array_to_string(statements,chr(10))) AS statements_md5 FROM supabase_migrations.schema_migrations ORDER BY version');assert.deepEqual(unchanged,history);
 report.only_pending_migration=name;pass('Authenticated production dry-run passed; history unchanged');
 if(mode==='apply') {
  stage='apply approved migration';run(['db','push','--linked','--skip-vault','--yes']);report.production_schema_writes=true;
  stage='verify release history';const after=query('SELECT version,name,md5(array_to_string(statements,chr(10))) AS statements_md5 FROM supabase_migrations.schema_migrations ORDER BY version');
  assert.equal(after.length,10);assert.deepEqual(after.slice(0,9),history);assert.equal(after[9].version,'20260918144301');assert.equal(after[9].name,'ting2_settings_table_isolation');pass('Exact approved migration version recorded; original history preserved');
 }
 report.result='PASS';
} catch(e){report.result='FAIL';report.stage=stage;report.reason=e.code==='ERR_ASSERTION'?'Release precondition or verification assertion failed':(e instanceof SyntaxError?'CLI did not return expected JSON':e.message);process.exitCode=1;}
finally {rmSync(work,{recursive:true,force:true});console.log(JSON.stringify(report,null,2));}
