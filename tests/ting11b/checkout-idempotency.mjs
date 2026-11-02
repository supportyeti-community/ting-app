import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../ting11b-cart.js', import.meta.url), 'utf8');

function makeSessionStorage({ failWrites = false } = {}) {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) {
            if (failWrites) throw new Error('storage unavailable');
            values.set(key, String(value));
        },
        removeItem(key) { values.delete(key); },
        dump() { return new Map(values); }
    };
}

function loadHooks(sessionStorage, generatedIds) {
    const ids = [...generatedIds];
    const window = {
        __TING_TEST__: true,
        addEventListener() {},
        location: { search: '', pathname: '/', hash: '' },
        history: { replaceState() {} }
    };
    const document = {
        readyState: 'loading',
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById() { return null; }
    };
    const context = vm.createContext({
        window,
        document,
        sessionStorage,
        clientSlug: 'the-bistro',
        tableIdentifier: '1',
        crypto: {
            randomUUID() {
                const next = ids.shift();
                if (!next) throw new Error('unexpected extra request id generation');
                return next;
            }
        },
        URLSearchParams,
        console,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(source, context, { filename: 'ting11b-cart.js' });
    return window.__tingCheckoutIdempotencyTestHooks;
}

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const storage = makeSessionStorage();

const firstLoad = loadHooks(storage, [firstId]);
assert(firstLoad, 'production checkout module must expose test hooks only under __TING_TEST__');
firstLoad.hydrateCheckoutAttempt();

const firstCart = [
    { menu_item_id: 'dish-b', quantity: 1 },
    { menu_item_id: 'dish-a', quantity: 2 }
];
const sameCartDifferentOrder = [
    { menu_item_id: 'dish-a', quantity: 2 },
    { menu_item_id: 'dish-b', quantity: 1 }
];

assert.equal(firstLoad.getOrCreateCheckoutRequestId(firstCart), firstId, 'first checkout must generate one request id');
assert.equal(
    firstLoad.getOrCreateCheckoutRequestId(sameCartDifferentOrder),
    firstId,
    'same cart retry in one page lifecycle must reuse the original request id'
);

const secondLoad = loadHooks(storage, [secondId]);
secondLoad.hydrateCheckoutAttempt();
assert.equal(
    secondLoad.getOrCreateCheckoutRequestId(sameCartDifferentOrder),
    firstId,
    'same cart after a page reload must recover and reuse the original request id'
);

assert.equal(
    secondLoad.getOrCreateCheckoutRequestId([
        { menu_item_id: 'dish-a', quantity: 3 },
        { menu_item_id: 'dish-b', quantity: 1 }
    ]),
    secondId,
    'a meaningful cart change must mint a new request id instead of reusing a stale attempt'
);

secondLoad.invalidateCheckoutAttempt();
const persistedKeys = [...storage.dump().keys()];
assert(!persistedKeys.some(key => key.includes('checkout-attempt')), 'explicit invalidation must clear the persisted checkout attempt');

const failedStorage = makeSessionStorage({ failWrites: true });
const storageFailureLoad = loadHooks(failedStorage, ['33333333-3333-4333-8333-333333333333']);
storageFailureLoad.hydrateCheckoutAttempt();
assert.equal(
    storageFailureLoad.getOrCreateCheckoutRequestId(firstCart),
    null,
    'checkout must not return a usable request id when its retry identity cannot be persisted'
);

assert(source.includes('hydrateCart();'), 'cart state must hydrate on reload before retry reconciliation');
assert(source.includes('persistCart();'), 'cart changes must persist for reload-safe uncertain retry recovery');
assert(source.includes('if (!persistCart()) {'), 'checkout must fail closed if the cart cannot be persisted before submission');
assert(source.includes('if (!requestId) {'), 'checkout must fail closed if the request identity cannot be persisted');
assert(source.includes('Your order was not sent'), 'storage failure must tell the guest that no order was submitted');
assert(source.includes('reconcileCheckoutAttemptWithCart();'), 'restored request identity must be checked against restored cart state');
assert(source.includes('clearCheckoutPersistence();'), 'successful checkout must clear persisted cart and request identity');
assert(source.includes('p_client_request_id: requestId'), 'the preserved request id must still be sent to submit_order');

console.log('PASS: uncertain checkout retries persist one request id across retry/reload and fail closed when that identity cannot be stored');
