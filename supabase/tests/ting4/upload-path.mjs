import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html = readFileSync(new URL('../../../admin.html',import.meta.url),'utf8');
const start = html.indexOf('    function menuPicturePath(');
const end = html.indexOf('    async function compressImage(',start);
assert(start >= 0 && end > start,'Admin path function unavailable');
const source = html.slice(start,end);
const suffix = '11111111-2222-4333-8444-555555555555';
let next = suffix;
const path = runInNewContext(source+'; menuPicturePath',{
  crypto:{randomUUID:()=>next},
});
const tenantA='10000000-0000-4000-8000-000000000001';
const tenantB='10000000-0000-4000-8000-000000000002';
assert.equal(path(tenantA,'image/jpeg'),`${tenantA}/${suffix}.jpg`);
assert.equal(path(tenantB,'image/png'),`${tenantB}/${suffix}.png`);
next='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
assert.equal(path(tenantA,'image/jpeg'),`${tenantA}/${next}.jpg`);
for (const tenant of ['',null,undefined,'the-bistro','../other','not-a-uuid/123']) {
  assert.throws(()=>path(tenant,'image/jpeg'),/Tenant unavailable/);
}
for (const mime of ['',null,'image/webp','image/svg+xml']) {
  assert.throws(()=>path(tenantA,mime),/Unsupported compressed image/);
}
assert.match(html,/const picturePath = menuPicturePath\(tenantId, compressedFile\.type\)/);
assert.match(html,/\.upload\(picturePath, compressedFile, \{ cacheControl: '3600', upsert: false \}\)/);
assert.match(html,/\.getPublicUrl\(picturePath\)/);
assert(!html.includes('upload(uniqueFileName'),'Flat menu image upload remains');
console.log('PASS: admin builds tenant UUID paths from compressed MIME and uses the same path for upload and public URL');
