// Starts only a new, disposable local Supabase project. Never links to a cloud project.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verify } from './verify.mjs';
import { historicalFiles, rehearseHistory } from './history.mjs';
import { rehearseTing2 } from './ting2.mjs';
import { rehearseTing4 } from './ting4.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const cli = join(root, 'node_modules/.bin/supabase');
const workdir = mkdtempSync(join(tmpdir(), 'ting-restore-'));
const projectId = workdir.split('/').at(-1);
const report = { scope: 'Disposable native Supabase restore and service smoke tests; not tenant isolation or production data recovery', production_writes: 0, checks: [] };
function command(args) {
  const result = spawnSync(cli, [...args, '--workdir', workdir], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    // No inherited cloud credentials; CLI status and startup output contain local keys.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SUPABASE_|PG|DATABASE_URL|DOCKER_HOST|DOCKER_CONTEXT)/.test(key))),
  });
  if (result.status !== 0) throw new Error(`Supabase ${args[0]} failed (exit ${result.status}); raw output withheld because it may contain credentials`);
  return result.stdout;
}
try {
  historicalFiles();
  report.cli = command(['--version']).trim();
  command(['init', '--yes']);
  const configPath = join(workdir, 'supabase/config.toml');
  const config = readFileSync(configPath, 'utf8');
  if (!config.includes('major_version = 17')) throw new Error('CLI default PostgreSQL version changed; review required');
  writeFileSync(configPath, config.replace(/project_id = "[^"]+"/, `project_id = "${projectId}"`));
  console.log('Starting disposable local Supabase services…');
  command(['start', '-x', 'studio,edge-runtime,logflare,vector,supavisor,postgres-meta']);
  const status = JSON.parse(command(['status', '-o', 'json']));
  if (process.env.TING_TEST_ISSUE === 'ting2') {
    report.scope = 'TING-2 settings/table-link release rehearsal on disposable native Supabase';
    await verify(status, report, null, db => rehearseTing2(db,status,report,command,workdir));
  } else if (process.env.TING_TEST_ISSUE === 'ting4') {
    report.scope = 'TING-4 Storage listing policy rehearsal on disposable native Supabase';
    await verify(status, report, null, (db,clients) => rehearseTing4(db,clients,report,command,workdir,status));
  } else {
    await verify(status, report, db => rehearseHistory(db,report,command,workdir));
  }
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL';
  // Test messages contain only static labels/codes, never API responses or credentials.
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  try { command(['stop', '--project-id', projectId, '--no-backup']); report.cleanup = 'PASS'; }
  catch { report.cleanup = 'FAIL'; process.exitCode = 1; report.result = 'FAIL'; }
  rmSync(workdir, { recursive: true, force: true });
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
