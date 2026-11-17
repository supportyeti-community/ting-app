/* FS-01B + FS-01A guest allergy presentation.
 * Only tenant-routed public RPC is authoritative for classifications.
 * Unknown, missing, stale, and failed status reads block ordinary cart interaction
 * while ANY allergy is selected; staff enquiry never changes this state.
 */
(() => {
  'use strict';
  const selected = new Set();
  let loaded = false;
  let statuses = new Map();
  let client = null;
  let generation = 0;
  let reloadPromise = null;
  const choices = [
    ['wheat','Wheat'],['barley','Barley'],['oats','Oats'],['rye','Rye'],
    ['fish','Fish'],['crustacean','Crustacean'],['mollusc','Mollusc'],
    ['egg','Egg'],['milk','Milk'],['lupin','Lupin'],['peanut','Peanut'],
    ['soy','Soy'],['sesame','Sesame'],['almond','Almond'],
    ['brazil_nut','Brazil nut'],['cashew','Cashew'],['hazelnut','Hazelnut'],
    ['macadamia','Macadamia'],['pecan','Pecan'],['pine_nut','Pine nut'],
    ['pistachio','Pistachio'],['walnut','Walnut'],['sulphites','Sulphites']
  ];
  const label = Object.fromEntries(choices);
  const picker = () => document.getElementById('fs01b-allergy-picker');
  const notify = () => window.dispatchEvent(new CustomEvent('ting:allergies-updated', {
    detail: { selected: [...selected], loaded }
  }));
  function assessment(itemId) {
    if (!selected.size) return {blocked:false, reasons:[]};
    const item = statuses.get(String(itemId));
    if (!loaded || !item) return {blocked:true, reasons:['Allergen assessment unavailable or not yet loaded']};
    const reasons = [];
    for (const code of selected) {
      const row = item.get(code);
      if (!row) {
        reasons.push(label[code] + ': unknown or missing assessment (unverified)');
      } else if (row.review_current !== true) {
        reasons.push(label[code] + ': unverified assessment (' + String(row.state || 'unknown').replaceAll('_',' ') + ')');
      } else if (row.state === 'contains') {
        reasons.push(label[code] + ': contains this allergen');
      } else if (row.state === 'may_contain') {
        reasons.push(label[code] + ': possible cross-contact / may contain');
      } else if (row.state !== 'assessed_absent') {
        reasons.push(label[code] + ': unknown assessment');
      }
    }
    return {blocked:reasons.length>0,reasons};
  }
  function blocked(itemId) { return assessment(itemId).blocked; }
  function apply() {
    const root = picker();
    const summary = root?.querySelector('[data-allergy-status]');
    if (summary) {
      summary.textContent = !selected.size
        ? 'No allergies selected. Dietary claims do not certify allergy or coeliac safety.'
        : !loaded
          ? 'Checking venue assessments. Ordering for selected allergies remains blocked until checked.'
          : 'Assessments shown below are venue-reported, not a guarantee of allergen-free or coeliac-safe preparation.';
    }
    document.querySelectorAll('.menu-card[data-id]').forEach(card => {
      const itemId=card.getAttribute('data-id');
      const r=assessment(itemId);
      let message=card.querySelector('.fs01b-allergy-warning');
      if (!message) {
        message=document.createElement('div');
        message.className='fs01b-allergy-warning';
        message.setAttribute('role','status');
        message.style.cssText='font-size:12px;color:#8b1d1d;background:#fff1f2;padding:8px;border-radius:8px;margin:4px 0';
        card.querySelector('.menu-body')?.append(message);
      }
      message.replaceChildren();
      message.hidden=!r.blocked;
      card.dataset.allergyBlocked=r.blocked?'true':'false';
      if (r.blocked) {
        const title=document.createElement('strong');
        title.textContent='⚠️ Allergy warning — ordinary ordering unavailable';
        const why=document.createElement('div');
        why.textContent=r.reasons.join('; ');
        const staff=document.createElement('button');
        staff.type='button'; staff.className='fs01b-ask-staff';
        staff.textContent='Ask Staff';
        staff.setAttribute('aria-label','Ask staff about allergens in this dish');
        staff.addEventListener('click',event=>{
          event.stopPropagation();
          if(typeof window.toggleModal==='function') window.toggleModal(true);
          // No override, verification, quantity change or cart mutation is allowed here.
        });
        message.append(title,why,staff);
      }
      const add=card.querySelector('.ting-card-action button.ting-add-btn');
      if (add) {add.disabled=r.blocked;add.setAttribute('aria-disabled',String(r.blocked));}
      card.style.minHeight=r.blocked?'160px':'';
      card.style.height=r.blocked?'auto':'';
      card.style.pointerEvents='auto'; // warning action remains usable even for unavailable dishes
    });
    notify();
  }
  function init() {
    const root=picker();
    if(!root||root.dataset.initialized)return;
    root.dataset.initialized='true';
    const details=document.createElement('details');
    const heading=document.createElement('summary');
    heading.textContent='⚠️ Select your allergies (optional, multiple selections)';
    const fields=document.createElement('div');
    fields.className='fs01b-allergy-options';
    fields.style.cssText='display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0';
    for(const [code,name] of choices){
      const wrapper=document.createElement('label');
      wrapper.style.cssText='display:flex;gap:6px;align-items:center;font-size:13px';
      const input=document.createElement('input');input.type='checkbox';input.value=code;
      input.setAttribute('aria-label','Allergy: '+name);
      input.addEventListener('change',()=>{
        if(input.checked)selected.add(code);else selected.delete(code);
        loaded=false;statuses=new Map();generation++;
        apply();
        if(selected.size)void fetchStatuses();
      });
      wrapper.append(input,document.createTextNode(name));fields.append(wrapper);
    }
    const status=document.createElement('p');
    status.setAttribute('role','status');status.dataset.allergyStatus='';
    status.style.cssText='font-size:13px;line-height:1.45;color:#7f1d1d';
    details.append(heading,fields);
    root.append(details,status);
    apply();
  }
  async function fetchStatuses() {
    if(!client||!selected.size){apply();return;}
    const version=++generation;
    loaded=false;statuses=new Map();apply();
    const call=client.rpc('get_menu_allergen_status');
    reloadPromise=call;
    try{
      const {data,error}=await call;
      if(version!==generation)return;
      if(error||!Array.isArray(data))throw Error('status read failed');
      const next=new Map();
      for(const row of data){
        if(typeof row.menu_item_id!=='string'||!label[row.allergen_code])continue;
        let item=next.get(row.menu_item_id);
        if(!item){item=new Map();next.set(row.menu_item_id,item);}
        item.set(row.allergen_code,row);
      }
      statuses=next;loaded=true;
    }catch{
      if(version!==generation)return;
      statuses=new Map();loaded=false;
    }finally{
      if(version===generation)apply();
    }
  }
  async function refresh(nextClient){
    client=nextClient;init();
    // Invalidates cached safety state whenever menu poll refreshes.
    if(selected.size) await fetchStatuses();
    else apply();
  }
  window.tingFs01Allergy={
    init,refresh,apply,blocked,assessment,
    hasSelection:()=>selected.size>0,
    ready:()=>loaded,
    awaitRefresh:()=>reloadPromise,
    selectedCodes:()=>[...selected]
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
