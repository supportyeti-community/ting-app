import assert from 'node:assert/strict';

const hostileStoredValues = [
  "Chef's special",
  'Double "quote" special',
  '\"><img src=x onerror=alert(1)>',
  "');alert(1);//",
];

for (const value of hostileStoredValues) {
  const node = { value: '', textContent: '', dataset: {} };
  node.value = value;
  node.textContent = value;
  node.dataset.searchName = value.toLowerCase();

  assert.equal(node.value, value);
  assert.equal(node.textContent, value);
  assert.equal(node.dataset.searchName, value.toLowerCase());
}

console.log('SEC-1 hostile stored-value property-assignment checks passed.');
