import test from 'node:test';
import assert from 'node:assert/strict';
import {NotionAdapter,WORK_ITEMS} from './notion-adapter.mjs';
const row={'Work Item ID':'16',Status:'Done',url:'https://app.notion.com/p/'+'a'.repeat(32),'Regression Evidence':'PASS'};
const source=(results,has_more=false)=>async args=>{assert.equal(args.data.data_source_url,WORK_ITEMS);return {structuredContent:{results,has_more}}};
test('Done/PASS never implies merged, deployed or production certified',async()=>{
 const [task]=await new NotionAdapter(source([row])).discover();
 assert.equal(task.eligible,false);assert.equal(task.reason,'already_completed');
 for(const key of ['merged','deployed','productionCertified'])assert.equal(task[key],null);
});
test('canonical missing execution fields block every incomplete task',async()=>{
 const [task]=await new NotionAdapter(source([{...row,Status:'Not started'}])).discover();
 assert.equal(task.reason,'execution_contract_missing');assert.equal(task.eligible,false);
});
test('Notion unavailable, partial pages, duplicate IDs and invented statuses fail closed',async()=>{
 for(const query of [async()=>{throw Error('offline')},source([row],true),source([row,row]),source([{...row,Status:'Approved'}])])
  await assert.rejects(new NotionAdapter(query).discover());
});
