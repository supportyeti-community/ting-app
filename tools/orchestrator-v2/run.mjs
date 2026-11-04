import {GitHubAPI,cycle} from './github-controller.mjs';
const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
if(!repository||!token)throw Error('missing GitHub Actions context');
const mode=process.argv[2]||'audit';
if(!['audit','claim'].includes(mode))throw Error('unsupported operation');
if(mode==='claim'&&(process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.TING_ORCHESTRATOR_CLAIM_ENABLED!=='true'))throw Error('claim requires manual dispatch with explicit enablement');
const result=await cycle(new GitHubAPI({repository,token}),{claim:mode==='claim'});
const summary=JSON.stringify(result,null,2);console.log(summary);
if(process.env.GITHUB_STEP_SUMMARY){
 const {appendFileSync}=await import('node:fs');
 appendFileSync(process.env.GITHUB_STEP_SUMMARY,'## TinG orchestrator v2 ('+mode+')\n\n```json\n'+summary+'\n```\n');
}
// Claim is ownership ONLY. No coding worker is launched.
