(() => {
    'use strict';

    const cart = new Map();
    let cartModal = null;
    let cartBar = null;
    let cartButton = null;
    let submitting = false;

    function money(value) {
        return `$${Number(value || 0).toFixed(2)}`;
    }

    function effectivePrice(item) {
        return Number(item.is_promo && item.promo_price != null ? item.promo_price : item.price);
    }

    function orderContextAvailable() {
        if (!clientSlug || !tableIdentifier) {
            showToastNotification('⚠️ Scan your table’s QR code before placing an order.');
            return false;
        }
        if (!supabaseInstance || !tenantId) {
            showToastNotification('⚠️ Venue connection unavailable. Please try again shortly.');
            return false;
        }
        return true;
    }

    function cartCount() {
        let count = 0;
        for (const item of cart.values()) count += item.quantity;
        return count;
    }

    function cartEstimate() {
        let total = 0;
        for (const item of cart.values()) total += item.unitPrice * item.quantity;
        return total;
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            body { padding-bottom: 188px !important; }
            .ting-cart-bar { position:fixed; left:0; right:0; bottom:84px; z-index:998; display:none; padding:0 16px; pointer-events:none; }
            .ting-cart-btn { pointer-events:auto; display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; max-width:440px; margin:0 auto; border:0; border-radius:18px; padding:14px 18px; background:var(--accent); color:white; font:inherit; font-weight:800; box-shadow:0 10px 28px rgba(15,23,42,.2); cursor:pointer; }
            .ting-card-action { position:absolute; right:10px; bottom:10px; z-index:2; }
            .ting-add-btn,.ting-qty-btn { border:0; border-radius:999px; background:var(--primary); color:white; font:inherit; font-weight:800; cursor:pointer; min-width:36px; height:34px; padding:0 12px; }
            .ting-qty-control { display:flex; align-items:center; gap:7px; background:white; border:1px solid #e2e8f0; border-radius:999px; padding:3px; box-shadow:0 2px 8px rgba(15,23,42,.08); }
            .ting-qty-btn { width:30px; min-width:30px; height:30px; padding:0; }
            .ting-qty-label { min-width:18px; text-align:center; font-size:13px; font-weight:900; }
            .ting-cart-overlay { display:none; position:fixed; inset:0; z-index:1400; background:rgba(15,23,42,.46); backdrop-filter:blur(4px); align-items:flex-end; }
            .ting-cart-sheet { width:100%; max-width:480px; margin:0 auto; max-height:82vh; overflow:auto; background:white; border-radius:24px 24px 0 0; padding:20px; box-sizing:border-box; }
            .ting-cart-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
            .ting-cart-close { border:0; background:#f1f5f9; width:36px; height:36px; border-radius:999px; cursor:pointer; font-size:18px; }
            .ting-cart-line { display:grid; grid-template-columns:1fr auto; gap:12px; padding:14px 0; border-bottom:1px solid #f1f5f9; text-align:left; }
            .ting-cart-line-name { font-size:14px; font-weight:800; margin-bottom:4px; }
            .ting-cart-line-price { color:#64748b; font-size:12px; }
            .ting-cart-summary { display:flex; justify-content:space-between; align-items:center; padding:18px 0 8px; font-weight:900; }
            .ting-place-order { width:100%; border:0; border-radius:16px; padding:16px; background:var(--primary); color:white; font:inherit; font-weight:900; cursor:pointer; }
            .ting-place-order:disabled { opacity:.55; cursor:not-allowed; }
            .ting-cart-note { color:#64748b; font-size:11px; line-height:1.4; margin:7px 0 14px; text-align:left; }
            .ting-order-success { text-align:center; padding:10px 4px 4px; }
            .ting-order-success h3 { margin:8px 0; font-size:21px; }
            .ting-order-ref { font-size:12px; color:#64748b; word-break:break-all; }
        `;
        document.head.appendChild(style);
    }

    function injectCartUi() {
        cartBar = document.createElement('div');
        cartBar.className = 'ting-cart-bar';
        cartBar.innerHTML = `<button type="button" class="ting-cart-btn" aria-label="View cart"><span id="tingCartCount">🛒 View Cart</span><span id="tingCartTotal">$0.00</span></button>`;
        document.body.appendChild(cartBar);
        cartButton = cartBar.querySelector('.ting-cart-btn');
        cartButton.addEventListener('click', openCart);

        cartModal = document.createElement('div');
        cartModal.className = 'ting-cart-overlay';
        cartModal.setAttribute('role', 'dialog');
        cartModal.setAttribute('aria-modal', 'true');
        cartModal.addEventListener('click', event => {
            if (event.target === cartModal) closeCart();
        });
        cartModal.innerHTML = `<div class="ting-cart-sheet" id="tingCartSheet"></div>`;
        document.body.appendChild(cartModal);
    }

    async function fetchMenuItem(itemId) {
        if (!orderContextAvailable()) return null;
        const { data, error } = await supabaseInstance
            .from('menu_items')
            .select('id,name,price,is_promo,promo_price,is_out_of_stock')
            .eq('tenant_id', tenantId)
            .eq('id', itemId)
            .maybeSingle();
        if (error || !data || data.is_out_of_stock) {
            showToastNotification('⚠️ This item is currently unavailable.');
            return null;
        }
        return data;
    }

    async function changeQuantity(itemId, delta) {
        if (submitting) return;
        const existing = cart.get(itemId);
        if (!existing && delta > 0) {
            const item = await fetchMenuItem(itemId);
            if (!item) return;
            cart.set(itemId, {
                id: item.id,
                name: item.name,
                unitPrice: effectivePrice(item),
                quantity: 1
            });
            logTelemetryAnalyticsEvent('cart_item_added', item.id, { quantity: 1 });
        } else if (existing) {
            const next = Math.max(0, Math.min(99, existing.quantity + delta));
            if (next === 0) cart.delete(itemId);
            else existing.quantity = next;
        }
        renderCartState();
    }

    function renderCardAction(card) {
        const itemId = card.getAttribute('data-id');
        if (!itemId) return;
        card.style.position = 'relative';
        let host = card.querySelector('.ting-card-action');
        if (!host) {
            host = document.createElement('div');
            host.className = 'ting-card-action';
            card.appendChild(host);
        }
        const item = cart.get(itemId);
        if (!item) {
            host.innerHTML = `<button type="button" class="ting-add-btn">+ Add</button>`;
            host.querySelector('button').addEventListener('click', event => {
                event.stopPropagation();
                changeQuantity(itemId, 1);
            });
            return;
        }
        host.innerHTML = `
            <div class="ting-qty-control" aria-label="Item quantity">
                <button type="button" class="ting-qty-btn" data-delta="-1">−</button>
                <span class="ting-qty-label">${item.quantity}</span>
                <button type="button" class="ting-qty-btn" data-delta="1">+</button>
            </div>`;
        host.querySelectorAll('[data-delta]').forEach(button => button.addEventListener('click', event => {
            event.stopPropagation();
            changeQuantity(itemId, Number(button.dataset.delta));
        }));
    }

    function decorateMenuCards() {
        document.querySelectorAll('.menu-card[data-id]').forEach(renderCardAction);
    }

    function renderCartState() {
        const count = cartCount();
        if (cartBar) cartBar.style.display = count > 0 ? 'block' : 'none';
        const countNode = document.getElementById('tingCartCount');
        const totalNode = document.getElementById('tingCartTotal');
        if (countNode) countNode.textContent = `🛒 View Cart · ${count} ${count === 1 ? 'item' : 'items'}`;
        if (totalNode) totalNode.textContent = money(cartEstimate());
        decorateMenuCards();
        if (cartModal?.style.display === 'flex') renderCartSheet();
    }

    function renderCartSheet() {
        const sheet = document.getElementById('tingCartSheet');
        if (!sheet) return;
        const items = [...cart.values()];
        if (!items.length) {
            closeCart();
            return;
        }
        sheet.innerHTML = `
            <div class="ting-cart-head">
                <div style="text-align:left"><h3 style="margin:0;font-size:20px">Your order</h3><div style="font-size:12px;color:#64748b;margin-top:3px">Table ${escapeHTML(String(tableNumber))}</div></div>
                <button type="button" class="ting-cart-close" aria-label="Close cart">×</button>
            </div>
            <div id="tingCartLines"></div>
            <div class="ting-cart-summary"><span>Estimated total</span><span>${money(cartEstimate())}</span></div>
            <div class="ting-cart-note">Final pricing and availability are revalidated by TinG when you place the order.</div>
            <button type="button" class="ting-place-order" ${submitting ? 'disabled' : ''}>${submitting ? 'Placing order…' : 'Place Order'}</button>`;
        sheet.querySelector('.ting-cart-close').addEventListener('click', closeCart);
        const lineHost = sheet.querySelector('#tingCartLines');
        for (const item of items) {
            const line = document.createElement('div');
            line.className = 'ting-cart-line';
            line.innerHTML = `
                <div><div class="ting-cart-line-name">${escapeHTML(item.name)}</div><div class="ting-cart-line-price">${money(item.unitPrice)} each · ${money(item.unitPrice * item.quantity)}</div></div>
                <div class="ting-qty-control">
                    <button type="button" class="ting-qty-btn" data-delta="-1">−</button>
                    <span class="ting-qty-label">${item.quantity}</span>
                    <button type="button" class="ting-qty-btn" data-delta="1">+</button>
                </div>`;
            line.querySelectorAll('[data-delta]').forEach(button => button.addEventListener('click', () => changeQuantity(item.id, Number(button.dataset.delta))));
            lineHost.appendChild(line);
        }
        sheet.querySelector('.ting-place-order').addEventListener('click', placeOrder);
    }

    function openCart() {
        if (!cart.size || !orderContextAvailable()) return;
        renderCartSheet();
        cartModal.style.display = 'flex';
    }

    function closeCart() {
        if (cartModal) cartModal.style.display = 'none';
    }

    async function submitOrderWithRetry(requestId, orderItems, retries = 3) {
        for (let attempt = 0; attempt < retries; attempt++) {
            const { data, error } = await supabaseInstance.rpc('submit_order', {
                p_table_number: tableNumber,
                p_client_request_id: requestId,
                p_items: orderItems
            });
            if (!error) return { data: Array.isArray(data) ? data[0] : data, error: null };
            if (String(error.code || '').startsWith('23') || attempt === retries - 1) return { data: null, error };
            await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
        }
        return { data: null, error: new Error('Order submission failed') };
    }

    async function placeOrder() {
        if (submitting || !cart.size || !orderContextAvailable()) return;
        submitting = true;
        renderCartSheet();

        const requestId = crypto.randomUUID();
        const orderItems = [...cart.values()].map(item => ({
            menu_item_id: item.id,
            quantity: item.quantity
        }));

        const { data: order, error } = await submitOrderWithRetry(requestId, orderItems);
        if (error || !order?.id) {
            submitting = false;
            renderCartSheet();
            const message = error?.message?.includes('out of stock')
                ? '⚠️ One of your items is now out of stock. Please review your cart.'
                : '⚠️ We could not place the order. Your cart is still here—please try again.';
            showToastNotification(message);
            return;
        }

        const submittedCount = cartCount();
        cart.clear();
        submitting = false;
        renderCartState();
        logTelemetryAnalyticsEvent('order_submitted', null, {
            order_id: order.id,
            item_count: submittedCount,
            status: order.status
        });
        showOrderConfirmation(order);
    }

    function showOrderConfirmation(order) {
        const sheet = document.getElementById('tingCartSheet');
        if (!sheet || !cartModal) return;
        cartModal.style.display = 'flex';
        sheet.innerHTML = `
            <div class="ting-order-success">
                <div style="font-size:42px">✅</div>
                <h3>Order received</h3>
                <p style="color:#64748b;margin:0 0 6px">Table ${escapeHTML(String(tableNumber))} · Status: ${escapeHTML(String(order.status || 'submitted'))}</p>
                <p style="font-size:18px;font-weight:900;margin:10px 0">${money(order.total)}</p>
                <p class="ting-order-ref">Order ${escapeHTML(String(order.id))}</p>
                <button type="button" class="ting-place-order" style="margin-top:18px">Back to menu</button>
            </div>`;
        sheet.querySelector('button').addEventListener('click', closeCart);
    }

    function startMenuObserver() {
        const wrapper = document.getElementById('menu-wrapper');
        if (!wrapper) return;
        const observer = new MutationObserver(() => decorateMenuCards());
        observer.observe(wrapper, { childList: true });
        decorateMenuCards();
    }

    function init() {
        try {
            injectStyles();
            injectCartUi();
            startMenuObserver();
            renderCartState();
            window.ting11bCartReady = true;
        } catch (error) {
            window.ting11bCartReady = false;
            console.error('TING-11B cart initialization failed safely:', error);
        }
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init, { once: true });
})();
