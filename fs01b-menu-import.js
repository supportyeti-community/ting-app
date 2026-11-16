/* FS-01B: Admin bulk menu importer. No formula execution, no client-owned tenant or review identity. */
(function () {
  'use strict';
  const FIELDS = ['category','name','description','price','available','image_url'];
  const REQUIRED = ['category','name','price'];
  const MAX_FILE = 1024 * 1024, MAX_ROWS = 500;
  const money = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/;
  const norm = s => String(s ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-AU');
  const text = (tag, value) => { const n = document.createElement(tag); n.textContent = value; return n; };
  const hasFormula = value => typeof value === 'string' && /^[\s]*[=+@]/.test(value);
  function validate(rows, existing) {
    const seen = new Set(), current = new Set(existing.map(x => norm(x.category) + '\u001f' + norm(x.name)));
    return rows.map((r, i) => {
      const errors = [];
      for (const field of REQUIRED) if (!String(r[field] ?? '').trim()) errors.push(field + ' required');
      for (const f of ['category','name','description','image_url']) if (hasFormula(r[f])) errors.push(f + ' contains spreadsheet formula-like content');
      if (String(r.category ?? '').trim().length > 100) errors.push('category too long');
      if (String(r.name ?? '').trim().length > 160) errors.push('dish name too long');
      if (String(r.description ?? '').length > 2000) errors.push('description too long');
      if (!money.test(String(r.price ?? '').trim())) errors.push('price must be an AUD decimal, up to two cents');
      const a = norm(r.available);
      if (!['','true','false','yes','no','1','0','available','out of stock'].includes(a)) errors.push('availability must be yes/no');
      const u = String(r.image_url ?? '').trim();
      if (u && (u.length > 1000 || !/^https:\/\/[^\s]+$/i.test(u))) errors.push('image URL must use HTTPS');
      const key = norm(r.category) + '\u001f' + norm(r.name);
      if (seen.has(key)) errors.push('duplicate row in this import');
      if (current.has(key)) errors.push('dish already exists in this category');
      seen.add(key);
      return { row: i + 2, errors };
    });
  }
  // Inspect ZIP central directory before decompressing XLSX. Reject zip bombs and macro/external-link payloads.
  async function inspectXlsx(file) {
    const data = new DataView(await file.arrayBuffer());
    let end = -1;
    for (let i=data.byteLength-22;i>=Math.max(0,data.byteLength-65557);i--) {
      if (data.getUint32(i,true)===0x06054b50) {end=i;break;}
    }
    if(end<0)throw Error('Invalid XLSX ZIP directory');
    const count=data.getUint16(end+10,true),size=data.getUint32(end+12,true),offset=data.getUint32(end+16,true);
    if(count===0||count>500||offset+size>data.byteLength)throw Error('XLSX archive exceeds safe limits');
    let pos=offset,total=0;
    for(let i=0;i<count;i++){
      if(pos+46>data.byteLength||data.getUint32(pos,true)!==0x02014b50)throw Error('Malformed XLSX archive');
      const flags=data.getUint16(pos+8,true),unpacked=data.getUint32(pos+24,true);
      const nameLength=data.getUint16(pos+28,true),extra=data.getUint16(pos+30,true),comment=data.getUint16(pos+32,true);
      if(flags&1||unpacked===0xffffffff)throw Error('Encrypted or ZIP64 XLSX not supported');
      if(pos+46+nameLength+extra+comment>data.byteLength)throw Error('Malformed ZIP entry');
      total+=unpacked;
      if(total>8*1024*1024)throw Error('XLSX exceeds 8 MB uncompressed safety limit');
      const name=new TextDecoder().decode(new Uint8Array(data.buffer,pos+46,nameLength)).toLowerCase();
      if(name.includes('vbaproject.bin')||name.startsWith('xl/externallinks/'))throw Error('XLSX macro or external-link content not permitted');
      pos+=46+nameLength+extra+comment;
    }
    if(pos!==offset+size)throw Error('Inconsistent XLSX directory');
  }
  function parseAvailable(value) {
    return !['false','no','0','out of stock'].includes(norm(value));
  }
  function mount(root, getClient, onSaved) {
    let grid = [], mapping = {}, rows = [], existing = [], requestId = crypto.randomUUID();
    let started = false, committed = false;
    root.replaceChildren();
    const heading = text('h3', 'Import CSV / Excel menu');
    const summary = text('p', 'Map columns, correct rows, then save a non-orderable draft. Every dish requires allergen review.');
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv,.xlsx'; input.setAttribute('aria-label','Menu spreadsheet');
    const status = text('p', 'Select a CSV or XLSX file (maximum 1 MB, 500 dishes).');
    status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const mappingHost = document.createElement('div'), preview = document.createElement('div');
    const save = text('button','Save draft menu'); save.type='button'; save.disabled=true;
    const reset = text('button','Start another import'); reset.type='button'; reset.hidden=true;
    root.append(heading,summary,input,status,mappingHost,preview,save,reset);
    const fail = e => { status.textContent = e.message || 'Import failed'; status.style.color='#fca5a5'; };
    const makeRows = () => {
      rows = grid.slice(1).filter(c => c.some(v => String(v ?? '').trim())).map(c => Object.fromEntries(FIELDS.map(f => [f, mapping[f] === '' ? '' : String(c[Number(mapping[f])] ?? '')])));
      requestId = crypto.randomUUID(); started = false; committed = false;
      render();
    };
    function render() {
      preview.replaceChildren();
      const checks = validate(rows, existing);
      const bad = checks.filter(x => x.errors.length).length;
      status.textContent = rows.length + ' rows; ' + bad + ' with validation errors. Draft dishes remain out of stock.';
      status.style.color = bad ? '#fbbf24' : '#86efac';
      const table = document.createElement('table');
      table.style.cssText='display:block;max-height:420px;overflow:auto;width:100%;font-size:12px';
      const header = document.createElement('tr');
      for (const f of ['row',...FIELDS,'errors']) header.append(text('th',f));
      table.append(header);
      rows.forEach((r,i) => {
        const tr=document.createElement('tr');tr.append(text('td',String(i+2)));
        for (const f of FIELDS) {
          const td=document.createElement('td'), edit=document.createElement('input');
          edit.value=String(r[f]??'');edit.setAttribute('aria-label','Row '+(i+2)+' '+f);
          edit.style.cssText='width:110px;background:#0b1329;color:white;border:1px solid #64748b';
          edit.disabled=started||committed;
          edit.addEventListener('change',()=>{r[f]=edit.value;requestId=crypto.randomUUID();render();});
          td.append(edit);tr.append(td);
        }
        tr.append(text('td',checks[i].errors.join('; ')));table.append(tr);
      });
      preview.append(table);
      save.disabled=committed||started||bad>0||rows.length===0||rows.length>MAX_ROWS;
    }
    input.addEventListener('change', async () => {
      try {
        const file=input.files[0]; if(!file) return;
        if(file.size===0||file.size>MAX_FILE) throw Error('File must be between 1 byte and 1 MB');
        const ext=file.name.toLowerCase().split('.').pop();
        if(ext==='csv') {
          if(typeof Papa==='undefined') throw Error('CSV parser unavailable');
          const parsed=Papa.parse(await file.text(),{skipEmptyLines:'greedy',dynamicTyping:false});
          if(parsed.errors.length) throw Error('CSV parsing error: '+parsed.errors[0].message);
          grid=parsed.data;
        } else if(ext==='xlsx') {
          if(typeof readXlsxFile!=='function') throw Error('XLSX parser unavailable');
          const sig=new Uint8Array(await file.slice(0,4).arrayBuffer());
          if(sig[0]!==0x50||sig[1]!==0x4b) throw Error('Invalid XLSX ZIP signature');
          await inspectXlsx(file);
          grid=await readXlsxFile(file);
        } else throw Error('Only CSV and XLSX files are supported');
        if(grid.length<2||grid.length-1>MAX_ROWS) throw Error('Provide 1–500 dish rows plus a heading row');
        if(grid.some(r=>r.length>40)) throw Error('Too many columns');
        const client=getClient();if(!client)throw Error('Admin session missing');
        const [{data:items,error:ie},{data:categories,error:ce}]=await Promise.all([
          client.from('menu_items').select('id,name,category_id'),
          client.from('menu_categories').select('id,name')
        ]);
        if(ie||ce)throw Error('Cannot check existing tenant dishes and categories');
        const names=new Map(categories.map(c=>[c.id,c.name]));
        existing=items.map(i=>({name:i.name,category:names.get(i.category_id)||''}));
        mappingHost.replaceChildren();mapping={};
        const titles=grid[0].map(x=>norm(x));
        for(const f of FIELDS) {
          const label=text('label',f+(REQUIRED.includes(f)?' *':'')+' ');
          const select=document.createElement('select');select.setAttribute('aria-label','Map '+f);
          const none=document.createElement('option');none.value='';none.textContent='Not provided';select.append(none);
          titles.forEach((t,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=String(grid[0][i]??'Column '+(i+1));select.append(o);});
          const aliases={category:['category','section','group'],name:['name','dish','dish name','item','item name'],description:['description','details'],price:['price','aud price','price aud'],available:['available','availability','in stock'],image_url:['image_url','image url','image']};
          const position=titles.findIndex(t=>aliases[f].includes(t));
          mapping[f]=position<0?'':String(position);select.value=mapping[f];
          select.addEventListener('change',()=>{mapping[f]=select.value;makeRows();});
          label.append(select);mappingHost.append(label,document.createElement('br'));
        }
        makeRows();
      } catch(e) {grid=[];rows=[];save.disabled=true;preview.replaceChildren();fail(e);}
    });
    save.addEventListener('click',async()=>{
      if(started||committed||validate(rows,existing).some(x=>x.errors.length))return;
      const client=getClient();if(!client)return fail(Error('Admin session expired'));
      const payload=rows.map(r=>({category:String(r.category).trim(),name:String(r.name).trim(),
        description:String(r.description??'').trim(),price:String(r.price).trim(),
        available:parseAvailable(r.available),image_url:String(r.image_url??'').trim()}));
      if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>524288)return fail(Error('Payload exceeds 512 KB'));
      started=true;save.disabled=true;status.textContent='Saving draft…';
      try {
        const {data,error}=await client.rpc('import_menu_draft',{p_request_id:requestId,p_rows:payload});
        if(error)throw Error('Server rejected import: '+error.message);
        if(!data||data.saved!==payload.length)throw Error('Unexpected server result; do not start a new request');
        committed=true;status.textContent=data.saved+' dishes saved as unverified, non-orderable drafts. Review each dish’s allergens before publishing.';
        reset.hidden=false;if(typeof onSaved==='function')await onSaved(data);
      }catch(e){fail(e);status.textContent+=' Retry the same request, without editing, if the network response was lost.';}
      finally{started=false;save.disabled=committed;}
    });
    reset.addEventListener('click',()=>{grid=[];rows=[];mapping={};existing=[];requestId=crypto.randomUUID();committed=false;started=false;input.value='';mappingHost.replaceChildren();preview.replaceChildren();reset.hidden=true;save.disabled=true;status.textContent='Select another file';});
  }
  window.mountFs01bMenuImport=mount;
  window.fs01bValidateRows=validate;
}());
