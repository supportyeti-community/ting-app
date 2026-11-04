import test from 'node:test';
import assert from 'node:assert/strict';
import {Ownership} from './ownership.mjs';
class Store {
 rows=new Map();
 async read(id){return structuredClone(this.rows.get(id)??null)}
 async cas(id,old,next){if(JSON.stringify(this.rows.get(id)??null)!==JSON.stringify(old))return false;this.rows.set(id,structuredClone(next));return true}
}
test('simultaneous claims have exactly one winner',async()=>{
 const s=new Store(),a=new Ownership(s),b=new Ownership(s);
 const claims=await Promise.all([a.acquire('WRK-100','A'),b.acquire('WRK-100','B')]);
 assert.equal(claims.filter(Boolean).length,1);
});
test('crashed worker expires, is quarantined and cannot resume or redispatch',async()=>{
 let now=0;const s=new Store(),o=new Ownership(s,{clock:()=>now,leaseMs:1000});
 const t=await o.acquire('WRK-100','A');now=1001;
 await assert.rejects(o.transition(t,'dispatched'),/stale/);
 assert.equal(await o.quarantine(t.id),true);
 assert.equal(await o.acquire(t.id,'B'),null);
 await assert.rejects(o.transition(t,'dispatched'),/stale/);
});
test('version fence prevents duplicate dispatch; evidence failure cannot reach review',async()=>{
 const o=new Ownership(new Store());let t=await o.acquire('WRK-100','A');const old=t;
 t=await o.transition(t,'dispatched');
 await assert.rejects(o.transition(old,'dispatched'),/stale/);
 t=await o.transition(t,'verified');
 await assert.rejects(o.transition(t,'review'),/invalid transition/);
 t=await o.transition(t,'failed',{reason:'evidence writeback failed'});
 await assert.rejects(o.transition(t,'recorded'),/invalid transition/);
 assert.equal(await o.acquire(t.id,'B'),null);
});
test('verified and recorded implementation stops at review',async()=>{
 const o=new Ownership(new Store());let t=await o.acquire('WRK-100','A');
 for(const state of ['dispatched','verified','recorded','review'])t=await o.transition(t,state);
 assert.equal(t.state,'review');assert.equal(await o.acquire(t.id,'B'),null);
});
test('quarantine between successful CAS and readback cannot lend new fence to stale worker',async()=>{
 const s=new Store();const original=s.cas.bind(s);
 s.cas=async(id,old,next)=>{const ok=await original(id,old,next);if(ok)s.rows.set(id,{...next,fence:'revoked',version:next.version+1,state:'quarantined'});return ok};
 await assert.rejects(new Ownership(s).acquire('WRK-100','A'),/readback/);
});
test('lost acquisition acknowledgement blocks retry instead of duplicating ownership',async()=>{
 const s=new Store();const original=s.cas.bind(s);
 s.cas=async(...args)=>{await original(...args);throw Error('lost acknowledgement')};
 const o=new Ownership(s);await assert.rejects(o.acquire('WRK-100','A'),/acknowledgement/);
 assert.equal(await o.acquire('WRK-100','A'),null);
});
