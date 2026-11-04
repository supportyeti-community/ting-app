/** GitHub commit journal. Every mutation is a child of the observed revision.
 * Non-force ref updates reject sibling writers. Never delete/reset these refs.
 * Controller credentials stay outside workers. This is not a security boundary
 * against repository administrators capable of rewriting refs.
 */
export class GitHubOwnershipStore {
 constructor(api,baseSha){if(!/^[a-f0-9]{40}$/.test(baseSha))throw Error('invalid base');this.api=api;this.baseSha=baseSha}
 ref(id){if(!/^[A-Z][A-Z0-9-]{2,63}$/.test(id))throw Error('invalid task');return 'heads/orch-journal/'+id}
 async read(id){
  let ref;try{ref=await this.api.call('GET','/git/ref/'+this.ref(id))}catch(e){if(e.status===404)return null;throw e}
  const commit=await this.api.call('GET','/git/commits/'+ref.object.sha);
  const prefix='TING-OWNERSHIP-V1\n';
  if(!commit.message.startsWith(prefix))throw Error('unrecognized ownership journal');
  const row=JSON.parse(commit.message.slice(prefix.length));
  if(row.id!==id)throw Error('ownership identity mismatch');
  return {...row,_revision:ref.object.sha};
 }
 async cas(id,old,next){
  const current=await this.read(id);
  if(JSON.stringify(current)!==JSON.stringify(old))return false;
  const parent=old?._revision??this.baseSha;
  const base=await this.api.call('GET','/git/commits/'+parent);
  const {_revision,...record}=next;
  const commit=await this.api.call('POST','/git/commits',{message:'TING-OWNERSHIP-V1\n'+JSON.stringify(record),tree:base.tree.sha,parents:[parent]});
  try {
   if(old)await this.api.call('PATCH','/git/refs/'+this.ref(id),{sha:commit.sha,force:false});
   else await this.api.call('POST','/git/refs',{ref:'refs/'+this.ref(id),sha:commit.sha});
   return true;
  }catch(e){if(e.status===422||e.status===409)return false;throw e}
 }
}
