// FS-01B real Chromium E2E on the SAME ephemeral Supabase stack as native REST tests.
// No cloud migrations, no master-Supabase network calls. Uses pinned local browser libraries.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import ExcelJS from 'exceljs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const native=fileURLToPath(new URL('.',import.meta.url));
const source=path=>readFileSync(join(root,path));
const label=(message,report)=>{report.checks.push(message);console.log('PASS: '+message);};
const codeLabels=[
 ['wheat','Wheat'],['barley','Barley (gluten-containing)'],
 ['oats','Oats (gluten-containing)'],['rye','Rye (gluten-containing)'],
 ['fish','Fish'],['crustacean','Crustacean'],['mollusc','Mollusc'],
 ['egg','Egg'],['milk','Milk'],['lupin','Lupin'],
 ['peanut','Peanut'],['soy','Soy'],['sesame','Sesame'],['almond','Almond'],
 ['brazil_nut','Brazil nut'],['cashew','Cashew'],['hazelnut','Hazelnut'],
 ['macadamia','Macadamia'],['pecan','Pecan'],['pine_nut','Pine nut'],
 ['pistachio','Pistachio'],['walnut','Walnut'],['sulphites','Sulphites']
];
async function minimalXlsx() {
 const workbook=new ExcelJS.Workbook();
 const sheet=workbook.addWorksheet('Menu');
 sheet.addRow(['category','name','price','available']);
 sheet.addRow(['Sides','Browser XLSX dish','14.20','no']);
 return Buffer.from(await workbook.xlsx.writeBuffer());
}

function legacyFile(path) {
 const result=spawnSync('git',['show','origin/main:'+path],{cwd:root,encoding:null,maxBuffer:4*1024*1024});
 if(result.status!==0)throw Error('Could not read recorded previous application from origin/main: '+path);
 return result.stdout;
}
function makeServer() {
 const oldIndex=legacyFile('index.html'),oldCart=legacyFile('ting11b-cart.js');
 const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const p=decodeURIComponent(u.pathname).replace(/^\/+/, '');
  let body;
  if(p==='legacy/index.html')body=oldIndex;
  else if(p==='legacy/ting11b-cart.js')body=oldCart;
  else if(['index.html','admin.html','fs01b-guest-allergy.js','fs01b-menu-import.js',
           'fs01b-allergen-review.js','fs01b-category-editor.js','ting11b-cart.js','ting11c-order-board.js'].includes(p))
    body=source(p);
  else{res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'Content-Type':p.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8',
                     'Cache-Control':'no-store'});
  res.end(body);
 });
 return server;
}
const localScript={
 supabase:join(native,'node_modules/@supabase/supabase-js/dist/umd/supabase.js'),
 papa:join(native,'node_modules/papaparse/papaparse.min.js'),
 xlsx:join(native,'node_modules/read-excel-file/bundle/read-excel-file.min.js')
};
async function routeBrowser(page,status) {
 await page.route('https://okrwklulwrfnrhnffbwp.supabase.co/**',async route=>{
  const req=route.request();
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS'}});
  if(!req.url().includes('/rest/v1/restaurant_clients'))throw Error('Unexpected master API request');
  return route.fulfill({status:200,contentType:'application/json',
    headers:{'access-control-allow-origin':'*','access-control-expose-headers':'*'},
    body:JSON.stringify({supabase_url:status.API_URL,supabase_anon_key:status.ANON_KEY})});
 });
 await page.route('https://cdn.jsdelivr.net/**',route=>{
  const url=route.request().url();
  const chosen=url.includes('@supabase/supabase-js')?'supabase':
    url.includes('/papaparse@')?'papa':
    url.includes('/read-excel-file@')?'xlsx':null;
  const body=chosen?readFileSync(localScript[chosen]):Buffer.from('window.QRCode=function(){};');
  return route.fulfill({status:200,contentType:'application/javascript',body});
 });
 await page.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({
  status:200,contentType:'application/javascript',body:'window.QRCode=function(){};'
 }));
 await page.route('https://images.unsplash.com/**',route=>route.abort());
}
const timeout=45000;
async function poll(page,selector){await page.locator(selector).waitFor({state:'visible',timeout});}
export async function rehearseFs01bBrowser({db,status,owner,email,password,report}) {
 const server=makeServer();
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
 const base='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const admin=await browser.newPage({viewport:{width:1320,height:960}});
  admin.setDefaultTimeout(timeout);
  await routeBrowser(admin,status);
  const errors=[];
  admin.on('pageerror',e=>errors.push(String(e.message).slice(0,140)));
  await admin.goto(base+'/admin.html?client=order-a',{waitUntil:'domcontentloaded'});
  await poll(admin,'#adminAuthForm');
  await admin.locator('#authEmail').fill(email);
  await admin.locator('#authPassword').fill(password);
  await admin.locator('#adminAuthForm button[type=submit]').click();
  await admin.locator('summary').filter({hasText:'Menu onboarding'}).click();
  await poll(admin,'#fs01b-menu-import input[type=file]');
  const categoryRoot=admin.locator('#fs01b-category-editor');
  await categoryRoot.getByLabel('New category name').fill('Browser Courses');
  await categoryRoot.getByRole('button',{name:'Add category'}).click();
  await categoryRoot.getByLabel('Category Browser Courses').waitFor({timeout});
  await categoryRoot.getByLabel('Category Browser Courses').fill('Browser Starters');
  await categoryRoot.getByLabel('Sort Browser Courses').fill('4');
  await categoryRoot.getByLabel('Category Browser Courses').locator('..').getByRole('button',{name:'Save category'}).click();
  await categoryRoot.getByLabel('Category Browser Starters').waitFor({timeout});
  const categoryNamed=(await db.query("SELECT name,sort_order FROM public.menu_categories WHERE tenant_id='10000000-0000-4000-8000-000000000011' AND name='Browser Starters'")).rows;
  assert.equal(categoryNamed.length,1);assert.equal(categoryNamed[0].sort_order,4);
  label('Playwright Admin category creation, rename and ordered tenant persistence',report);
  // CSV mapping and editable preview, deliberate invalid price then repair.
  const upload=admin.locator('#fs01b-menu-import input[type=file]');
  const csv='category,name,description,price,available\nMains,Browser CSV dish,Allergen review required,abc,yes\n';
  await upload.setInputFiles({name:'menu.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await poll(admin,'#fs01b-menu-import table');
  const save=admin.getByRole('button',{name:'Save draft menu'});
  assert(await save.isDisabled(),'invalid CSV price should block save');
  await admin.getByLabel('Row 2 price').fill('12.50');
  await admin.getByLabel('Row 2 price').press('Tab');
  assert(!(await save.isDisabled()),'corrected valid CSV should allow draft save');
  await save.click();
  await admin.getByText('1 dishes saved as unverified', {exact:false}).waitFor({timeout});
  const created=(await db.query("SELECT id,import_draft,is_out_of_stock,price FROM public.menu_items WHERE name='Browser CSV dish'")).rows;
  assert.equal(created.length,1);
  assert(created[0].import_draft&&created[0].is_out_of_stock);
  label('Playwright Admin CSV mapping, invalid price repair, atomic draft persistence',report);

  // XLSX fixture is a real XLSX ZIP with a worksheet, not a CSV renamed .xlsx.
  await admin.getByRole('button',{name:'Start another import'}).click();
  await upload.setInputFiles({name:'menu.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:await minimalXlsx()});
  try { await poll(admin,'#fs01b-menu-import table'); }
  catch(error) {
    const displayed=await admin.locator('#fs01b-menu-import [role=status]').innerText().catch(()=>'(no UI status)');
    const diag=await admin.evaluate(async()=>{
      const file=document.querySelector('#fs01b-menu-import input[type=file]')?.files?.[0];
      try {
        const parsed=file&&typeof readXlsxFile==='function'?await readXlsxFile(file):null;
        return {fileSize:file?.size,parser:typeof readXlsxFile,rowCount:parsed?.length,
          columns:parsed?.[0]?.length,
          sample:parsed?.slice(0,2)?.map(row=>row.slice(0,4).map(v=>String(v??'').slice(0,20)))};
      }catch(e){return {fileSize:file?.size,parser:typeof readXlsxFile,parseError:String(e.message).slice(0,180)};}
    });
    throw new Error('XLSX preview unavailable: '+displayed.slice(0,350)+'; parser diagnostic: '+JSON.stringify(diag)+'; browser errors: '+errors.join(' | '));
  }
  assert(!(await save.isDisabled()),'valid XLSX should enable draft save');
  await save.click();
  await admin.getByText('1 dishes saved as unverified',{exact:false}).waitFor({timeout});
  const xlsx=(await db.query("SELECT id,import_draft,is_out_of_stock,import_requested_available FROM public.menu_items WHERE name='Browser XLSX dish'")).rows;
  assert.equal(xlsx.length,1);
  assert(xlsx[0].import_draft&&xlsx[0].is_out_of_stock&&!xlsx[0].import_requested_available);
  label('Playwright Admin XLSX real ZIP parsing, preview and persisted unavailable draft',report);

  // Complete 23-code assessment via real UI and authenticated version-fenced RPCs.
  await admin.locator('#fs01b-allergen-review select[aria-label="Choose a dish to review"]')
    .selectOption({label:'Browser CSV dish — Import draft'});
  await admin.getByRole('button',{name:'Open dish review'}).click();
  await poll(admin,'#fs01b-allergen-review textarea[aria-label="Recipe context"]');
  await admin.getByLabel('Recipe context').fill('Verified recipe and supplier data for browser fixture');
  await admin.getByLabel('Preparation context').fill('Shared-equipment assessment completed in fixture');
  await admin.getByRole('button',{name:'Save recipe and preparation context'}).click();
  for(const [code,name] of codeLabels){
   const selector=admin.getByLabel(name+' classification',{exact:true});
   await selector.selectOption(code==='milk'?'contains':code==='egg'?'may_contain':code==='peanut'?'unknown':'assessed_absent');
   await selector.locator('..').getByRole('button',{name:'Save assessment'}).click();
  }
  await admin.getByRole('button',{name:'Verify complete allergen assessment'}).click();
  await admin.getByText('Verified. Publish only after checking',{exact:false}).waitFor({timeout});
  await admin.getByRole('button',{name:'Publish reviewed dish'}).click();
  await admin.getByText('Dish published.',{exact:false}).waitFor({timeout});
  const published=(await db.query("SELECT i.id,i.import_draft,r.verified_version,r.safety_version FROM public.menu_items i JOIN public.menu_item_allergen_reviews r ON r.menu_item_id=i.id WHERE i.name='Browser CSV dish'")).rows[0];
  assert(!published.import_draft&&published.verified_version===published.safety_version);
  label('Playwright complete Admin 23-code recipe, versioned review, verify, publish',report);

  const access=await owner.rpc('issue_table_access_context',{p_table_number:'12'});
  if(access.error)throw Error('Unable to issue isolated table capability for browser test: '+access.error.code);
  const context=Array.isArray(access.data)?access.data[0]:access.data;
  assert(context?.token,'Missing token in disposable test capability');
  const guestUrl=base+'/index.html?client=order-a&table=12&ctx='+encodeURIComponent(context.token);
  const guest=await browser.newPage({viewport:{width:430,height:930}});
  guest.setDefaultTimeout(timeout);
  await routeBrowser(guest,status);
  guest.on('pageerror',e=>errors.push('guest:'+String(e.message).slice(0,140)));
  await guest.goto(guestUrl,{waitUntil:'domcontentloaded'});
  await poll(guest,'.menu-card[data-id="'+published.id+'"]');
  const dish=guest.locator('.menu-card[data-id="'+published.id+'"]');
  await guest.locator('#fs01b-allergy-picker summary').click();
  await guest.getByLabel('Allergy: Milk').check();
  await guest.waitForFunction(id=>document.querySelector('.menu-card[data-id="'+id+'"]')?.dataset.allergyBlocked==='true',published.id);
  assert((await dish.locator('.fs01b-allergy-warning').innerText()).includes('contains'));
  assert(await dish.locator('.ting-add-btn').count()===0,'blocked dish must not expose Add');
  const ticketsBefore=Number((await db.query("SELECT count(*) n FROM public.service_tickets WHERE tenant_id='10000000-0000-4000-8000-000000000011'")).rows[0].n);
  await dish.getByRole('button',{name:'Ask Staff'}).click();
  await poll(guest,'#pagerModal');
  assert(await guest.locator('#pagerModal').isVisible());
  await guest.locator('#modalContent button.opt-btn').filter({hasText:'Medical Allergy Inquiry'}).click();
  let ticketsAfter=ticketsBefore;
  for(let t=0;t<20&&ticketsAfter===ticketsBefore;t++){
    await guest.waitForTimeout(250);
    ticketsAfter=Number((await db.query("SELECT count(*) n FROM public.service_tickets WHERE tenant_id='10000000-0000-4000-8000-000000000011'")).rows[0].n);
  }
  assert.equal(ticketsAfter,ticketsBefore+1,'Ask Staff must create one real authenticated-table service ticket');
  assert(await guest.evaluate(id=>window.tingFs01Allergy.blocked(id),published.id),'Ask Staff must not bypass block');
  label('Playwright Guest contains warning, real Ask Staff ticket and no bypass',report);
  await guest.evaluate(()=>window.toggleModal(false));

  await guest.getByLabel('Allergy: Milk').uncheck();
  await guest.getByLabel('Allergy: Egg').check();
  await guest.waitForFunction(id=>document.querySelector('.menu-card[data-id="'+id+'"] .fs01b-allergy-warning')?.textContent.includes('cross-contact'),published.id);
  await guest.getByLabel('Allergy: Egg').uncheck();
  await guest.getByLabel('Allergy: Peanut').check();
  await guest.waitForFunction(id=>document.querySelector('.menu-card[data-id="'+id+'"] .fs01b-allergy-warning')?.textContent.includes('unknown'),published.id);
  await guest.getByLabel('Allergy: Peanut').uncheck();
  await guest.getByLabel('Allergy: Wheat').check();
  await guest.waitForFunction(id=>document.querySelector('.menu-card[data-id="'+id+'"]')?.dataset.allergyBlocked==='false',published.id);
  assert(!(await guest.evaluate(id=>window.tingFs01Allergy.blocked(id),published.id)));
  label('Playwright Guest may-contain, unknown, assessed-absent and multiple-selection transitions',report);

  // Previous app artifact from main, hosted against expanded schema, is the app rollback rehearsal.
  // It must continue to read legacy dishes and must not receive unpublished imported drafts.
  const versionedBefore=(await db.query('SELECT verified_version,safety_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[published.id])).rows[0];
  const legacy=await browser.newPage({viewport:{width:430,height:930}});
  legacy.setDefaultTimeout(timeout);
  await routeBrowser(legacy,status);
  await legacy.goto(base+'/legacy/index.html?client=order-a&table=12&ctx='+encodeURIComponent(context.token),{waitUntil:'domcontentloaded'});
  await poll(legacy,'.menu-card[data-id="'+published.id+'"]');
  assert.equal(await legacy.locator('.menu-card').filter({hasText:'Browser XLSX dish'}).count(),0,'legacy app must not see draft via RLS');
  assert.equal(await legacy.locator('.menu-card').filter({hasText:'Browser CSV dish'}).count(),1);
  await legacy.getByRole('button',{name:'View Live Menu'}).click();
  await legacy.locator('.menu-card[data-id="'+published.id+'"] .ting-add-btn').click();
  await legacy.getByText('View Cart',{exact:false}).click();
  await legacy.getByRole('button',{name:'Place Order'}).click();
  await legacy.getByText('Order received',{exact:false}).waitFor({timeout});
  assert.equal(Number((await db.query('SELECT count(*) n FROM public.order_items WHERE menu_item_id=$1',[published.id])).rows[0].n),1);
  assert.equal((await db.query('SELECT verified_version,safety_version FROM public.menu_item_allergen_reviews WHERE menu_item_id=$1',[published.id])).rows[0].verified_version,versionedBefore.verified_version);
  assert((await db.query("SELECT to_regclass('public.menu_import_batches') AS v")).rows[0].v,'expanded schema lost during legacy app restore');
  label('Playwright restored prior-main application submits real order with expanded schema, reviews retained and drafts hidden',report);
  assert.deepEqual(errors,[],'Browser application page errors: '+errors.join(' | '));
 }finally {
  if(browser)await browser.close();
  await new Promise(done=>server.close(done));
 }
}
