import assert from 'node:assert/strict';
import test from 'node:test';
// FS-01A model-level acceptance probes: NOT database/RLS/runtime certification.
// Intended to pin the conservative classification rule until a real guest read API exists.
export function classifyAssessment(selected,assessments,review) {
 if (!selected.length) return 'no_filter';
 const current=review?.verified_version != null && review.verified_version===review?.safety_version;
 if (!current) return 'unknown';
 let result='assessed_absent';
 for (const code of selected) {
  const state=assessments[code]??'unknown';
  if (state==='contains') return 'contains';
  if (state==='may_contain') result='may_contain';
  else if (state!=='assessed_absent' && result!=='may_contain') result='unknown';
 }
 return result;
}
const verified={safety_version:2,verified_version:2};
test('missing entry is unknown even if review is current',()=>assert.equal(classifyAssessment(['milk'],{},verified),'unknown'));
test('stale review is unknown',()=>assert.equal(classifyAssessment(['milk'],{milk:'assessed_absent'},{safety_version:3,verified_version:2}),'unknown'));
test('all chosen allergens must be assessed absent',()=>assert.equal(classifyAssessment(['milk','egg'],{milk:'assessed_absent',egg:'assessed_absent'},verified),'assessed_absent'));
test('contains dominates a second unknown',()=>assert.equal(classifyAssessment(['milk','egg'],{milk:'contains'},verified),'contains'));
test('may contain is not safe',()=>assert.equal(classifyAssessment(['milk'],{milk:'may_contain'},verified),'may_contain'));
test('no filter is not a safety certification',()=>assert.equal(classifyAssessment([],{},null),'no_filter'));
test('missing review is unknown',()=>assert.equal(classifyAssessment(['sesame'],{sesame:'assessed_absent'},null),'unknown'));
