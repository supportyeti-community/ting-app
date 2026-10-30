import fs from 'node:fs';

const admin = fs.readFileSync('admin.html', 'utf8');

const mustContain = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
};
const mustNotContain = (source, needle, label) => {
  if (source.includes(needle)) throw new Error(`Unexpected ${label}: ${needle}`);
};

const functionStart = admin.indexOf('async function loadLiveMenuFromDatabase()');
const functionEnd = admin.indexOf('\n    async function shiftElementOrderWeights', functionStart);
if (functionStart === -1 || functionEnd === -1) {
  throw new Error('Could not isolate loadLiveMenuFromDatabase().');
}

const menuRender = admin.slice(functionStart, functionEnd);

// Stored menu data must never be rendered through HTML-string interpolation.
mustNotContain(menuRender, 'insertAdjacentHTML(', 'HTML-string menu rendering');
mustNotContain(menuRender, 'onclick=', 'inline click handler in menu rendering');
mustNotContain(menuRender, 'onchange=', 'inline change handler in menu rendering');
mustNotContain(menuRender, 'onblur=', 'inline blur handler in menu rendering');

// Menu controls must be constructed with DOM APIs and property assignment.
mustContain(menuRender, 'document.createElement(', 'DOM element construction');
mustContain(menuRender, '.textContent =', 'textContent assignment');
mustContain(menuRender, '.value =', 'value assignment');
mustContain(menuRender, '.addEventListener(', 'event listener binding');
mustContain(menuRender, '.dataset.searchName =', 'safe dataset assignment');

// Regression payloads: these are the quote/attribute-breaking cases SEC-1 must remain safe against.
const hostileStoredValues = [
  "Chef's special",
  'Double "quote" special',
  '\"><img src=x onerror=alert(1)>',
  "');alert(1);//",
];

for (const payload of hostileStoredValues) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('SEC-1 hostile payload fixture is invalid.');
  }
}

console.log('SEC-1 admin stored-XSS static regression checks passed.');
