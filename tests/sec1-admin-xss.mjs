import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const admin = fs.readFileSync('admin.html', 'utf8');
const functionStart = admin.indexOf('async function loadLiveMenuFromDatabase()');
const functionEnd = admin.indexOf('\n    async function shiftElementOrderWeights', functionStart);
if (functionStart === -1 || functionEnd === -1) throw new Error('Could not isolate loadLiveMenuFromDatabase().');

const menuRender = admin.slice(functionStart, functionEnd);
const mustContain = (needle, label) => {
  if (!menuRender.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
};
const mustNotContain = (needle, label) => {
  if (menuRender.includes(needle)) throw new Error(`Unexpected ${label}: ${needle}`);
};

mustNotContain('insertAdjacentHTML(', 'HTML-string menu rendering');
mustNotContain('onclick=', 'inline click handler in menu rendering');
mustNotContain('onchange=', 'inline change handler in menu rendering');
mustNotContain('onblur=', 'inline blur handler in menu rendering');
mustContain('document.createElement(', 'DOM element construction');
mustContain('.textContent =', 'textContent assignment');
mustContain('.value =', 'value assignment');
mustContain('.addEventListener(', 'event listener binding');
mustContain('.dataset.searchName =', 'safe dataset assignment');

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.events = {};
    this.className = '';
    this.id = '';
    this.type = '';
    this.value = '';
    this.textContent = '';
    this.placeholder = '';
    this.checked = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) { this.events[type] = listener; }
}

const flatten = (root) => [root, ...root.children.flatMap(flatten)];
const hostileStoredValues = [
  "Chef's special",
  'Double "quote" special',
  '\"><img src=x data-sec1=marker>',
  "');SEC1_MARKER;//",
];

for (const payload of hostileStoredValues) {
  const inventory = new FakeElement('div');
  const pricing = new FakeElement('div');
  const dish = {
    id: '11111111-1111-4111-8111-111111111111',
    name: payload,
    description: payload,
    price: 12.5,
    promo_price: null,
    is_promo: false,
    is_out_of_stock: false,
  };
  let stockToggleArgs = null;

  const query = {
    select() { return this; },
    eq() { return this; },
    async order() { return { data: [dish], error: null }; },
  };

  const context = {
    console,
    tenantId: '22222222-2222-4222-8222-222222222222',
    trackingCachedMenuItems: [],
    supabaseInstance: { from() { return query; } },
    document: {
      getElementById(id) {
        if (id === 'dynamicInventoryContainer') return inventory;
        if (id === 'dynamicPricingContainer') return pricing;
        return null;
      },
      createElement(tagName) { return new FakeElement(tagName); },
    },
    refreshLiveAnalyticsMetrics() {},
    shiftElementOrderWeights() {},
    updateDishFieldInline() {},
    deleteDishPermanently() {},
    broadcastPriceUpdate() {},
    toggleHappyHour() {},
    updatePromoPriceValue() {},
    toggleItemStock(...args) { stockToggleArgs = args; },
  };

  vm.runInNewContext(menuRender, context);
  await context.loadLiveMenuFromDatabase();

  assert.equal(inventory.children.length, 1, 'inventory card count changed');
  assert.equal(pricing.children.length, 1, 'pricing card count changed');

  const inventoryNodes = flatten(inventory);
  const pricingNodes = flatten(pricing);
  const allNodes = [...inventoryNodes, ...pricingNodes];
  assert.equal(allNodes.some(node => node.tagName === 'img' || node.tagName === 'script'), false, 'hostile value created markup');

  const nameInput = inventoryNodes.find(node => node.className === 'inline-input-text');
  const description = inventoryNodes.find(node => node.className === 'inline-textarea');
  const priceName = pricing.children[0].children[0];
  assert.equal(nameInput.value, payload, 'dish name was not assigned as a value');
  assert.equal(description.value, payload, 'description was not assigned as a value');
  assert.equal(priceName.textContent, payload, 'dish name was not assigned as textContent');
  assert.equal(inventory.children[0].dataset.searchName, payload.toLowerCase(), 'search dataset changed payload');

  const stockCheckbox = inventoryNodes.find(node => node.type === 'checkbox');
  stockCheckbox.checked = true;
  stockCheckbox.events.change();
  assert.deepEqual(stockToggleArgs, [dish.id, payload, true], 'event listener did not preserve stored value safely');
}

console.log('SEC-1 admin stored-XSS regression checks passed.');
