import test from 'node:test';
import assert from 'node:assert/strict';
import {selectNext, claimSelected, handoffToReview} from './core.mjs';
const row=(id, overrides={})=>({id,state:'ready',risk:'low',approvalRequired:false,version:0,priority:'P2',dependencies:[],owner:null,...overrides});
class AtomicStore {
  constructor(rows){this.rows=new Map(rows.map(r=>[r.id,{...r}]));}
  async compareAndSwap(x) {
    const r=this.rows.get(x.id);
    if(!r || r.version!==x.expectedVersion || r.state!==x.expectedState ||
       (r.owner??null)!==(x.expectedOwner??null)) return false;
    Object.assign(r,{version:r.version+1,state:x.nextState,owner:x.nextOwner});
    if(x.evidenceUrl) r.evidenceUrl=x.evidenceUrl;
    return true;
  }
}
test('selection is deterministic, dependency gated, and fail closed for risky work',()=>{
  const rows=[row('TING-101',{priority:'P2'}),row('TING-102',{priority:'P1',risk:'high'}),
    row('TING-103',{priority:'P1',approvalRequired:true}),
    row('TING-104',{priority:'P1',dependencies:['TING-105']}),
    row('TING-105',{state:'blocked'})];
  assert.deepEqual(selectNext(rows),{id:'TING-101',version:0});
});
test('unknown dependency and duplicate IDs fail closed',()=>{
  assert.throws(()=>selectNext([row('TING-101',{dependencies:['TING-999']})]));
  assert.throws(()=>selectNext([row('TING-101'),row('TING-101')]));
});
test('same snapshot cannot be claimed twice; only one worker wins',async()=>{
  const snapshot=[row('TING-101')],store=new AtomicStore(snapshot);
  const result=await Promise.all([claimSelected(store,snapshot,'WORKER-A'),claimSelected(store,snapshot,'WORKER-B')]);
  assert.equal(result.filter(x=>x.status==='claimed').length,1);
  assert.equal(result.filter(x=>x.status==='conflict').length,1);
});
test('stale versions and wrong owners cannot handoff',async()=>{
  const snapshot=[row('TING-101')],store=new AtomicStore(snapshot);
  assert.equal((await claimSelected(store,snapshot,'WORKER-A')).status,'claimed');
  assert.equal((await handoffToReview(store,{id:'TING-101',version:1,workerId:'WORKER-B',evidenceUrl:'https://github.com/x/y/pull/1'})).status,'conflict');
  assert.equal((await handoffToReview(store,{id:'TING-101',version:0,workerId:'WORKER-A',evidenceUrl:'https://github.com/x/y/pull/1'})).status,'conflict');
  assert.equal((await handoffToReview(store,{id:'TING-101',version:1,workerId:'WORKER-A',evidenceUrl:'https://github.com/x/y/pull/1'})).status,'review_required');
  assert.equal(store.rows.get('TING-101').state,'review');
});
test('no implicit approval and no dispatch without eligible work',async()=>{
  const snapshot=[row('PAY-200',{risk:'high'}),row('TING-202',{approvalRequired:true})];
  assert.equal(selectNext(snapshot),null);
  assert.equal((await claimSelected(new AtomicStore(snapshot),snapshot,'WORKER-A')).status,'nothing_eligible');
});
