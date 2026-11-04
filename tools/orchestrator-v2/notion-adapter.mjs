/** Bounded connector adapter. Existing canonical schema has no execution contract.
 * Missing fields deliberately block dispatch; prose is never parsed as approval.
 */
export const WORK_ITEMS='collection://778ce4eb-a36c-40a2-96b1-b132bac8103f';
export class NotionAdapter {
 constructor(query){this.query=query}
 async discover(){
  const response=await this.query({data:{mode:'rows',data_source_url:WORK_ITEMS,limit:100}});
  if(response.isError)throw Error('Notion unavailable');
  const data=response.structuredContent??JSON.parse(response.content?.[0]?.text);
  if(!Array.isArray(data?.results)||data.has_more!==false)throw Error('incomplete canonical snapshot');
  const ids=new Set();
  return data.results.map(row=>{
   const id=String(row['Work Item ID']??'');
   if(!/^\d+$/.test(id)||ids.has(id)||!['Not started','In progress','Done'].includes(row.Status))throw Error('ambiguous canonical record');
   ids.add(id);
   if(!/^https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}$/.test(row.url??''))throw Error('invalid canonical page');
   return {id:'WRK-'+id,url:row.url,status:row.Status,title:row['Work Item'],eligible:false,
    reason:row.Status==='Done'?'already_completed':'execution_contract_missing',
    evidence:row['Regression Evidence']??'',merged:null,deployed:null,productionCertified:null};
  });
 }
}
