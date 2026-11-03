const RE=/^```orchestrator-task\s*\n([\s\S]*?)\n```/m;
const required=['orchestrator:ready','orchestrator:low-risk','orchestrator:approved'];
export function parseTask(issue){
 if(!issue||issue.pull_request||!Number.isSafeInteger(issue.number)||issue.number<1||issue.state!=='open'||!Array.isArray(issue.labels)||typeof issue.body!=='string')return null;
 const labels=new Set(issue.labels.map(x=>typeof x==='string'?x:x.name));
 if(!required.every(x=>labels.has(x)))return null;
 const match=issue.body.match(RE);if(!match)return null;
 let task;try{task=JSON.parse(match[1])}catch{return null}
 if(!task||Object.keys(task).some(k=>!['kind','workItemId','notionUrl','dependencies','approvalRequired','risk'].includes(k))||
 task.kind!=='repo-audit'||task.risk!=='low'||task.approvalRequired!==false||
 !/^[A-Z][A-Z0-9-]{2,63}$/.test(task.workItemId||'')||
 !/^https:\/\/app\.notion\.com\/p\/[a-zA-Z0-9-]+(?:\?.*)?$/.test(task.notionUrl||'')||
 !Array.isArray(task.dependencies)||task.dependencies.length>20||
 task.dependencies.some(n=>!Number.isSafeInteger(n)||n<1||n===issue.number)||
 new Set(task.dependencies).size!==task.dependencies.length)return null;
 return {issue:issue.number,...task};
}
export function chooseEligible(issues,claims){
 if(!Array.isArray(issues)||!Array.isArray(claims))throw Error('incomplete source snapshot');
 const byId=new Map();
 for(const issue of issues){if(!issue||!Number.isSafeInteger(issue.number)||byId.has(issue.number))throw Error('duplicate/invalid issue');byId.set(issue.number,issue)}
 const claimed=new Set(claims);
 const eligible=issues.map(parseTask).filter(Boolean).filter(t=>!claimed.has(t.issue)&&t.dependencies.every(dep=>{
 const x=byId.get(dep);return x&&x.state==='closed'&&Array.isArray(x.labels)&&x.labels.some(l=>(typeof l==='string'?l:l.name)==='orchestrator:verified');
 }));
 eligible.sort((a,b)=>a.issue-b.issue);return eligible[0]||null;
}
export class GitHubAPI{
 constructor({token,repository,request=fetch}){if(!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repository||'')||!token)throw Error('missing scoped GitHub configuration');this.repo=repository;this.token=token;this.request=request}
 async call(method,path,body){
 const response=await this.request('https://api.github.com/repos/'+this.repo+path,{method,headers:{Authorization:'Bearer '+this.token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json().catch(()=>null);
 if(!response.ok){const e=Error('GitHub '+method+' '+path+': '+response.status);e.status=response.status;throw e}return data;
 }
 async issues(){
 const all=[];for(let page=1;page<=10;page++){const batch=await this.call('GET','/issues?state=all&per_page=100&page='+page);
 if(!Array.isArray(batch))throw Error('unexpected issues response');all.push(...batch);if(batch.length<100)return all}
 throw Error('issue pagination incomplete; refuse selection');
 }
 async refs(){
 const all=[];for(let page=1;page<=10;page++){let batch;try{batch=await this.call('GET','/git/matching-refs/heads/orch-claims/issue-?per_page=100&page='+page)}
 catch(e){if(e.status===404)return [];throw e}if(!Array.isArray(batch))throw Error('unexpected refs response');all.push(...batch);
 if(batch.length<100)return all.map(r=>Number(r.ref?.match(/^refs\/heads\/orch-claims\/issue-(\d+)$/)?.[1])).filter(Number.isSafeInteger)}
 throw Error('claim pagination incomplete; refuse selection');
 }
 async main(){const d=await this.call('GET','/git/ref/heads/main');if(!/^[a-f0-9]{40}$/.test(d.object?.sha||''))throw Error('invalid main SHA');return d.object.sha}
 async claim(issue,sha){try{await this.call('POST','/git/refs',{ref:'refs/heads/orch-claims/issue-'+issue,sha});return 'claimed'}catch(e){if(e.status===422)return 'conflict';throw e}}
}
export async function cycle(api,{claim=false}={}){
 const [issues,refs]=await Promise.all([api.issues(),api.refs()]);const task=chooseEligible(issues,refs);
 if(!task)return {status:'no_eligible_task'};if(!claim)return {status:'eligible_not_claimed',task};
 const refreshed=await api.issues();const candidate=chooseEligible(refreshed,await api.refs());
 if(!candidate||candidate.issue!==task.issue)return {status:'snapshot_changed'};
 const sha=await api.main();const outcome=await api.claim(task.issue,sha);
 return {status:outcome,task:candidate,claimRef:'refs/heads/orch-claims/issue-'+candidate.issue};
}
