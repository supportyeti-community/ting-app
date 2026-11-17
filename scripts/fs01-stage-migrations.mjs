// FS-01 Founder gate: build a CLI-only history overlay; never change canonical migrations.
// Production-applied versions and names were read from Supabase schema_migrations on 2026-11-17.
// The overlay is discarded after use. It MUST NEVER be used to bootstrap a database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const entries=`
20260731143616 ting_secure_tenant_foundation 5021f413cb52f49f68f542637999d34a
20260801163330 ting_harden_security_definer_functions 0748ebd97be38bbef6eddab636d61453
20260801174026 ting_seed_internal_demo_tenant_v3 fe252a9079813d8216265cc4e6a3b96c
20260801181205 ting_backfill_internal_demo_history df174a7a0b322bfbce81baca5408c161
20260803090652 ting_remove_internal_demo_slug_defaults b0e0a2e5e6222922fc75942a0016f6fc
20260803120714 ting9_service_ticket_ownership_expansion d5d6d31b2099aa3e3071daa867a94058
20260805041650 ting9_service_ticket_ownership_enforcement ecc9268cddaf23aeba102be44e43bfaf
20260805041932 ting9_rollback_enforcement_after_upsert_rls_regression 9c6c00a08b27281e705ad51e01148617
20260805042037 ting9_reapply_enforcement_after_deployed_writer_confirmation 85e386a503794fd52dbb65530c72e7f3
20260918144301 ting2_settings_table_isolation 8bf8b4181b3396733a160adb392e57b6
20260922054639 ting2_menu_item_isolation 8a03634da74dd2c9ac7b4c4579864851
20260922155033 ting2_menu_event_isolation a33e485871be86033c26d2eaaa4acbca
20260923101432 ting2_service_ticket_authorization 967198add728eb74023162b961114412
20260923113515 ting2_routing_registry_prepare 76f15376d04cae86e63e860aeba92c6f
20260923132307 ting2_route_scope_registry e907dffb7ff86ad6b84322a608a2435e
20260923200127 ting4_restrict_menu_picture_listing ec84ebc0c50ec740ac48ab95efe982a5
20260925013625 ting4_scope_menu_picture_writes 2f1024c9034eca30923f7178b5ee13be
20260925093356 ting8_admin_membership_gate 883f3e52fb0be1ea17c8f5d92392c1c9
20260930030209 ting6_harden_sanitize_text_search_path 5396daa47a4e08f99db673945d795a36
20261008082142 ting11_ordering_foundation 5ddb4b76ce2ad12ae18afd26c2424fd5
20261008082156 ting11_order_item_tenant_coupling 935e355be5a51e4a6c38b910b5ee794c
20261008111104 pay1_payment_foundation 998ba2809f6fd3e0bf519312dc0648ab
20261008111706 pay1_hardening f17294b9185426d74ff15dbfcf38db3e
20261014191710 ting11_table_access_context f126a8975cd5f871aca82e6e9e57c4de
20261014193154 ting11_service_ticket_table_context 93fc99f6638d5112e92404a3c870a233
20261030122153 ops1_orders_realtime 79cb39c7fb998679d6b5b481020e5b4e
20261031221339 ting11_cap1_table_capability_lifecycle d0e9b7fc790b05ced01731da51e0298c`.trim().split('\n').map(s=>{const [version,name,ledgerMd5]=s.trim().split(/\s+/);return {version,name,ledgerMd5};});
const target=['20261116000000_fs01a_menu_category_allergen_contract.sql','20261117000000_fs01b_bulk_menu_draft_import.sql'];
const repo=process.cwd(),source=path.join(repo,'supabase/migrations');
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'fs01-ledger-stage-'));
const migrated=path.join(stage,'supabase/migrations');
fs.mkdirSync(migrated,{recursive:true});
const all=fs.readdirSync(source).filter(s=>s.endsWith('.sql')).sort();
const md5=s=>crypto.createHash('md5').update(s).digest('hex');
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
const report={productionLedgerVersions:entries.map(e=>e.version),history:[],localOnly:[],newMigrations:[]};
for(const entry of entries){
 const found=all.filter(n=>n.startsWith(entry.version+'_'));
 if(found.length>1)throw Error('Duplicate source version: '+entry.version);
 const matching=all.filter(n=>md5(fs.readFileSync(path.join(source,n),'utf8'))===entry.ledgerMd5);
 // Only an exact hash match can be considered an authoritative text reconstruction.
 const matchingSql=matching.length===1?matching[0]:null;
 const content=matchingSql?fs.readFileSync(path.join(source,matchingSql),'utf8'):
  '-- LEDGER-ONLY STAGING PLACEHOLDER: ALREADY APPLIED IN PRODUCTION.\n-- NOT AN AUTHORITATIVE RECONSTRUCTION OR BOOTSTRAP MIGRATION.\n-- version '+entry.version+', name '+entry.name+', recorded MD5 '+entry.ledgerMd5+'\n';
 const filename=entry.version+'_'+entry.name+'.sql';
 fs.writeFileSync(path.join(migrated,filename),content);
 report.history.push({...entry,localVersionFile:found[0]||null,exactRepositorySql:matchingSql,overlayType:matchingSql?'exact-sql':'applied-ledger-placeholder'});
}
for(const filename of target){
 if(!all.includes(filename))throw Error('Missing FS file: '+filename);
 const sql=fs.readFileSync(path.join(source,filename),'utf8');
 fs.writeFileSync(path.join(migrated,filename),sql);
 report.newMigrations.push({filename,sha256:sha256(sql)});
}
const applied=new Set(entries.map(x=>x.version));
for(const filename of all){
 const version=filename.split('_')[0];
 if(!applied.has(version)&&!target.includes(filename))report.localOnly.push(filename);
}
if(fs.readdirSync(migrated).length!==entries.length+target.length)throw Error('Bad staging file count');
fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(report,null,2));
console.log('STAGE_DIR='+stage);
console.log('PRODUCTION_APPLIED_COUNT='+entries.length);
console.log('EXPECTED_FORWARD_COUNT='+target.length);
console.log('LEDGER_PLACEHOLDER_COUNT='+report.history.filter(x=>x.overlayType==='applied-ledger-placeholder').length);
console.log('EXACT_SQL_MATCH_COUNT='+report.history.filter(x=>x.overlayType==='exact-sql').length);
console.log('HISTORICAL_LEDGER_MAP='+JSON.stringify(report.history.map(({version,name,localVersionFile,exactRepositorySql,overlayType})=>({version,name,localVersionFile,exactRepositorySql,overlayType}))));
console.log('LOCAL_ONLY_FILES='+JSON.stringify(report.localOnly));
console.log('FS_FORWARD_SHA256='+JSON.stringify(report.newMigrations));
