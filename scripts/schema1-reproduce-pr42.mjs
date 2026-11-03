// Instrument only the exact historical local harness; never print raw CLI output.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const scope=process.argv[3]||'pay1';const migration=scope==='pay2'?'20261015020000':'20261008110500';
const dir=process.argv[2];assert(dir,'Historical checkout required');
const path=dir+'/supabase/baseline/native/run.mjs';let text=readFileSync(path,'utf8');
const old='if (result.status !== 0) throw new Error(`Supabase ${args[0]} failed (exit ${result.status}); raw output withheld because it may contain credentials`);';
assert(text.includes(old),'Historical command wrapper changed');
const replacement=`if (result.status !== 0) {
 const output=(result.stdout||'')+'\\n'+(result.stderr||'');
 const known='Found local migration files to be inserted before the last migration on remote database.';
 const diagnostic=output.includes(known)?known:'No allowlisted diagnostic matched';
 report.cli_failure={command:args,exit:result.status,diagnostic,
 migration_ids:[...new Set((output.match(/${migration}/g)||[]))]};
 throw new Error('Historical CLI failure: '+diagnostic);
}`;
writeFileSync(path,text.replace(old,replacement));
const child=spawnSync(process.execPath,['supabase/baseline/native/run.mjs'],{cwd:dir,env:{...process.env,TING_TEST_ISSUE:scope},stdio:'inherit',timeout:1100000});
const result=JSON.parse(readFileSync(dir+'/supabase/baseline/native/result.json','utf8'));
assert.equal(child.status,1,'Historical failure did not reproduce');
assert.equal(result.cleanup,'PASS','Disposable cleanup failed');
assert.equal(result.cli_failure?.diagnostic,'Found local migration files to be inserted before the last migration on remote database.','Different native failure');
assert.deepEqual(result.cli_failure.command,['db','push','--local','--dry-run','--skip-vault','--yes']);
assert(result.cli_failure.migration_ids.includes(migration),'PAY-1 version absent from diagnostic');
console.log('PASS: '+scope+' native failure reproduced: chronological ledger rejection before payment SQL execution');
