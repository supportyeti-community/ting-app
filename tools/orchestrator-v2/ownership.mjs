/** Durable ownership protocol. Store CAS must atomically compare the full revision.
 * Workers never receive publication credentials. Expiry quarantines uncertain work;
 * it never authorizes redispatch. A reconciler must prove termination first.
 */
import {randomUUID} from 'node:crypto';
export class Ownership {
 constructor(store,{clock=Date.now,leaseMs=60000}={}) {
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000)throw Error('invalid lease');
  this.store=store;this.clock=clock;this.leaseMs=leaseMs;
 }
 async acquire(id,owner) {
  if(!/^[A-Z][A-Z0-9-]{2,63}$/.test(id)||!owner)throw Error('invalid identity');
  const old=await this.store.read(id);
  if(old)return null; // Includes failed, expired and review records: no automatic replay.
  const row={id,owner,fence:randomUUID(),version:1,state:'claimed',expires:this.clock()+this.leaseMs,events:[{state:'claimed',at:this.clock()}]};
  return await this.store.cas(id,null,row)?await this.store.read(id):null;
 }
 async transition(token,state,detail={}) {
  const allowed={claimed:['dispatched','failed','released'],dispatched:['verified','failed'],verified:['recorded','failed'],recorded:['review'],review:[],failed:[],released:[]};
  const old=await this.store.read(token.id);
  if(!old||old.fence!==token.fence||old.owner!==token.owner||old.version!==token.version||old.expires<=this.clock())throw Error('stale ownership');
  if(!allowed[old.state]?.includes(state))throw Error('invalid transition');
  const next={...old,version:old.version+1,state,detail,events:[...old.events,{state,at:this.clock()}]};
  if(!await this.store.cas(token.id,old,next))throw Error('ownership conflict');
  return await this.store.read(token.id);
 }
 async quarantine(id) {
  const old=await this.store.read(id);
  if(!old||old.expires>this.clock()||['review','failed','released','quarantined'].includes(old.state))return false;
  return this.store.cas(id,old,{...old,fence:randomUUID(),version:old.version+1,state:'quarantined',events:[...old.events,{state:'quarantined',at:this.clock()}]});
 }
}
