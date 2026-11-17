/* FS-01B Admin category editor. Authenticated, tenant-RLS constrained writes only. */
(()=>{
'use strict';
const node=(tag,value)=>{const el=document.createElement(tag);if(value!==undefined)el.textContent=value;return el;};
async function mount(root,clientProvider,tenantProvider,onChange){
 root.replaceChildren();
 const heading=node('h3','Categories & dish placement');
 const notice=node('p','Organise menu categories. Uncategorised historical dishes are preserved.');
 const name=document.createElement('input');name.placeholder='Category name';name.maxLength=100;name.setAttribute('aria-label','New category name');
 const create=node('button','Add category');create.type='button';
 const list=node('div'),itemList=node('div');
 root.append(heading,notice,name,create,list,node('h4','Assign a dish to a category'),itemList);
 const error=e=>{notice.textContent=e?.message||'Category operation failed';notice.style.color='#fca5a5';};
 const getContext=()=>{const client=clientProvider(),tenantId=tenantProvider();if(!client||!tenantId)throw Error('Tenant admin session is unavailable');return {client,tenantId};};
 let busy=false;
 async function refresh(){
   try {
    const {client,tenantId}=getContext();
    const [{data:categories,error:ce},{data:dishes,error:de}]=await Promise.all([
      client.from('menu_categories').select('id,name,sort_order').eq('tenant_id',tenantId).order('sort_order').order('id'),
      client.from('menu_items').select('id,name,category_id').eq('tenant_id',tenantId).order('sort_order').limit(1000)
    ]);
    if(ce||de)throw Error('Unable to load categories or menu items');
    list.replaceChildren();itemList.replaceChildren();
    for(const cat of categories){
      const line=node('div');
      line.style.cssText='display:flex;gap:8px;flex-wrap:wrap;padding:6px 0';
      const edit=document.createElement('input');edit.value=cat.name;edit.maxLength=100;edit.setAttribute('aria-label','Category '+cat.name);
      const order=document.createElement('input');order.type='number';order.step='1';order.value=String(cat.sort_order);order.setAttribute('aria-label','Sort '+cat.name);order.style.width='70px';
      const save=node('button','Save category');save.type='button';
      save.addEventListener('click',async()=>{
        if(busy)return;busy=true;save.disabled=true;
        try {
          const label=edit.value.trim(),n=Number(order.value);
          if(!label||label.length>100||!Number.isSafeInteger(n))throw Error('Provide a category name and integer order');
          const {error}=await client.from('menu_categories').update({name:label,sort_order:n}).eq('tenant_id',tenantId).eq('id',cat.id);
          if(error)throw error;
          notice.textContent='Category updated';if(onChange)await onChange();await refresh();
        }catch(e){error(e);}finally{busy=false;save.disabled=false;}
      });
      line.append(edit,order,save);list.append(line);
    }
    for(const dish of dishes){
      const line=node('label',dish.name+' ');line.style.cssText='display:block;margin:6px 0;font-size:12px';
      const select=document.createElement('select');select.setAttribute('aria-label','Category for '+dish.name);
      const none=node('option','Uncategorised');none.value='';select.append(none);
      for(const cat of categories){const option=node('option',cat.name);option.value=cat.id;select.append(option);}
      select.value=dish.category_id||'';
      select.addEventListener('change',async()=>{
        if(busy)return;busy=true;select.disabled=true;
        try{
          const {error}=await client.from('menu_items').update({category_id:select.value||null})
            .eq('tenant_id',tenantId).eq('id',dish.id);
          if(error)throw error;
          notice.textContent='Dish category saved';if(onChange)await onChange();
        }catch(e){error(e);select.value=dish.category_id||'';}finally{busy=false;select.disabled=false;}
      });
      line.append(select);itemList.append(line);
    }
   }catch(e){error(e);}
 }
 create.addEventListener('click',async()=>{
  if(busy)return;busy=true;create.disabled=true;
  try{
    const {client,tenantId}=getContext();const label=name.value.trim();
    if(!label||label.length>100)throw Error('Enter a valid category name (1–100 characters)');
    const {error}=await client.from('menu_categories').insert({tenant_id:tenantId,name:label});
    if(error)throw error;name.value='';notice.textContent='Category created';await refresh();if(onChange)await onChange();
  }catch(e){error(e);}finally{busy=false;create.disabled=false;}
 });
 await refresh();
 return {refresh};
}
window.mountFs01bCategories=mount;
})();