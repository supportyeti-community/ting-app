/* FS-01B structured Admin allergen review; FS-01A RPCs remain authoritative. */
(function(){
'use strict';
const el=(tag,t)=>{const n=document.createElement(tag);if(t!==undefined)n.textContent=t;return n;};
async function mount(root,getClient,onChanged){
 root.replaceChildren();
 const heading=el('h3','Dish allergen review');
 const intro=el('p','Every code must be assessed against recipe and preparation. Imported tags are not proof. Verification is restricted to an authorised owner/admin.');
 const choose=document.createElement('select');choose.setAttribute('aria-label','Choose a dish to review');
 const load=el('button','Open dish review');load.type='button';
 const status=el('p','Select a dish.');status.setAttribute('role','status');
 const detail=el('div');
 root.append(heading,intro,choose,load,status,detail);
 const failure=e=>{status.textContent=e.message||'Could not complete allergen review';status.style.color='#fca5a5';};
 let items=[],codes=[];
 async function refresh(){
  try{
   const client=getClient();if(!client)return;
   const [a,b]=await Promise.all([
    client.from('menu_items').select('id,name,import_draft,import_requested_available,is_out_of_stock').order('created_at',{ascending:false}).limit(1000),
    client.from('menu_allergen_codes').select('code,label').eq('active',true).order('label')
   ]);
   if(a.error||b.error)throw Error('Unable to load tenant menu and allergen vocabulary');
   items=a.data;codes=b.data;
   choose.replaceChildren();
   for(const i of items){const o=el('option',i.name+(i.import_draft?' — Import draft':''));o.value=i.id;choose.append(o);}
  }catch(e){failure(e);}
 }
 async function open(){
  detail.replaceChildren();const id=choose.value;if(!id)return;
  const client=getClient();
  const [rr,aa]=await Promise.all([
   client.from('menu_item_allergen_reviews').select('safety_version,verified_version,recipe_context,preparation_context').eq('menu_item_id',id).single(),
   client.from('menu_item_allergen_assessments').select('allergen_code,state,evidence_note').eq('menu_item_id',id)
  ]);
  if(rr.error||aa.error)return failure(Error('Review records unavailable or access denied'));
  let version=Number(rr.data.safety_version);
  const recipe=el('textarea');recipe.value=rr.data.recipe_context||'';recipe.placeholder='Ingredients, recipe and supplier information';
  recipe.setAttribute('aria-label','Recipe context');
  const preparation=el('textarea');preparation.value=rr.data.preparation_context||'';preparation.placeholder='Cross-contact, preparation and shared equipment';
  preparation.setAttribute('aria-label','Preparation context');
  const contextButton=el('button','Save recipe and preparation context');
  contextButton.type='button';
  const list=el('div');
  const states=['unknown','contains','may_contain','assessed_absent'];
  const values=new Map(aa.data.map(a=>[a.allergen_code,a]));
  let pending=false, verifyButton=null;
  const busy=v=>{pending=v;contextButton.disabled=v;for(const button of list.querySelectorAll('button'))button.disabled=v;if(verifyButton)verifyButton.disabled=v;};
  contextButton.addEventListener('click',async()=>{
   if(pending)return;busy(true);
   try{const {data,error}=await client.rpc('set_menu_item_safety_context',{p_item_id:id,p_recipe:recipe.value,p_preparation:preparation.value,p_expected_version:version});
     if(error)throw Error(error.message);version=Number(data);status.textContent='Context saved. Review requires all classifications again if source data changed.';
   }catch(e){failure(e);}finally{busy(false);}
  });
  for(const code of codes){
    const wrapper=el('label',code.label+' ');
    const select=document.createElement('select');
    select.setAttribute('aria-label',code.label+' classification');
    for(const state of states){const op=el('option',state.replaceAll('_',' '));op.value=state;select.append(op);}
    select.value=values.get(code.code)?.state||'unknown';
    const note=document.createElement('input');note.placeholder='Evidence / supplier details';
    note.value=values.get(code.code)?.evidence_note||'';
    note.setAttribute('aria-label',code.label+' evidence');
    const apply=el('button','Save assessment');apply.type='button';
    apply.addEventListener('click',async()=>{
      if(pending)return;busy(true);
      try{const {data,error}=await client.rpc('set_menu_item_allergen',{p_item_id:id,p_code:code.code,p_state:select.value,p_evidence_note:note.value||null,p_expected_version:version});
       if(error)throw Error(error.message);version=Number(data);status.textContent=code.label+' saved. Verification is now stale until complete.';
      }catch(e){failure(e);}finally{busy(false);}
    });
    wrapper.append(select,note,apply);list.append(wrapper,el('br'));
  }
  const verify=el('button','Verify complete allergen assessment');verify.type='button';verifyButton=verify;
  const publish=el('button','Publish reviewed dish');publish.type='button';publish.disabled=true;
  verify.addEventListener('click',async()=>{
   if(pending)return;busy(true);
   try{
    const {error}=await client.rpc('verify_menu_item_allergens',{p_item_id:id,p_expected_version:version});
    if(error)throw Error(error.message);
    publish.disabled=false;status.textContent='Verified. Publish only after checking the displayed dish and price.';
   }catch(e){failure(e);}finally{busy(false);}
  });
  publish.addEventListener('click',async()=>{
   if(pending)return;busy(true);
   try {
    // Re-check the DB review stamp immediately before changing publish state.
    const {data:review,error:re}=await client.from('menu_item_allergen_reviews').select('safety_version,verified_version').eq('menu_item_id',id).single();
    if(re||!review||review.verified_version===null||Number(review.safety_version)!==Number(review.verified_version))
      throw Error('Review is no longer current. Reverify before publishing.');
    const {error}=await client.from('menu_items').update({import_draft:false,is_out_of_stock:!(items.find(i=>i.id===id)?.import_requested_available??true)}).eq('id',id).eq('import_draft',true);
    if(error)throw Error(error.message);
    publish.disabled=true;status.textContent='Dish published. Allergen warnings remain governed by verified classification.';
    if(onChanged)await onChanged();
    await refresh();
   }catch(e){failure(e);}finally{busy(false);}
  });
  detail.append(el('p','Safety version '+version+'. Current verification: '+(rr.data.verified_version===rr.data.safety_version?'yes':'no')),
     el('label','Recipe details'),recipe,el('label','Preparation details'),preparation,contextButton,list,verify,publish);
  status.textContent='Review dish '+(items.find(i=>i.id===id)?.name||'');
 }
 load.addEventListener('click',open);await refresh();
 return {refresh};
}
window.mountFs01bAllergenReview=mount;
}());
