(() => {
  'use strict';

  const ACTIVE_STATUSES = ['submitted', 'accepted', 'preparing', 'ready'];
  const STATUS_ACTIONS = {
    submitted: { next: 'accepted', label: 'Accept Order' },
    accepted: { next: 'preparing', label: 'Start Preparing' },
    preparing: { next: 'ready', label: 'Mark Ready' },
    ready: { next: 'completed', label: 'Complete Order' }
  };
  const RECONCILE_INTERVAL_MS = 15000;
  const REFRESH_TIMEOUT_MS = 10000;

  let orderBoardChannel = null;
  let boardInitialized = false;
  let refreshInFlight = false;
  let refreshQueued = false;
  let pollingTimer = null;
  let lastSuccessfulRefreshAt = 0;
  let lastRefreshFailed = false;
  let realtimeState = 'connecting';

  function money(value) {
    const amount = Number(value || 0);
    return `$${amount.toFixed(2)}`;
  }

  function safeText(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function installSecureTableQrGenerator() {
    window.generateTableQrCodeCanvas = async function generateTableQrCodeCanvas() {
      const input = document.getElementById('qrTargetTable');
      const wrapper = document.getElementById('qrContainerWrapper');
      const targetArea = document.getElementById('qrCodeTargetArea');
      const zone = document.getElementById('qrGenerationZone');
      const generateButton = zone?.querySelector('button');
      const tableNumRaw = input?.value.trim() || '';

      if (!/^[A-Za-z0-9 _-]{1,20}$/.test(tableNumRaw)) {
        alert('Specify a valid table number.');
        return;
      }
      if (typeof supabaseInstance === 'undefined' || !supabaseInstance || typeof tenantId === 'undefined' || !tenantId) {
        alert('Restaurant authorization is not ready.');
        return;
      }
      if (!wrapper || !targetArea || typeof QRCode === 'undefined') {
        alert('QR generator is unavailable.');
        return;
      }

      const previousLabel = generateButton?.textContent || 'Generate QR';
      if (generateButton) {
        generateButton.disabled = true;
        generateButton.textContent = 'Securing…';
      }

      try {
        const { data, error } = await supabaseInstance.rpc('issue_table_access_context', {
          p_table_number: tableNumRaw
        });
        if (error) throw error;

        const issued = Array.isArray(data) ? data[0] : data;
        const token = String(issued?.token || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(token) || issued?.table_number !== tableNumRaw) {
          throw new Error('Secure table capability was not returned');
        }

        const link = new URL('https://ting.supportyeti.com/');
        link.searchParams.set('client', clientSlug);
        link.searchParams.set('table', tableNumRaw);
        link.searchParams.set('ctx', token);

        targetArea.innerHTML = '';
        wrapper.style.display = 'block';
        new QRCode(targetArea, {
          text: link.toString(),
          width: 160,
          height: 160,
          colorDark: '#000000',
          colorLight: '#ffffff'
        });

        setTimeout(() => {
          const canvas = targetArea.querySelector('canvas');
          if (!canvas) return;
          document.getElementById('qrDlBtn')?.remove();
          const dlBtn = document.createElement('button');
          dlBtn.id = 'qrDlBtn';
          dlBtn.className = 'qr-dl-btn';
          dlBtn.innerText = '📥 Save Secured PNG';
          dlBtn.onclick = () => {
            const a = document.createElement('a');
            a.download = `QR_Table_${tableNumRaw}.png`;
            a.href = canvas.toDataURL('image/png');
            a.click();
          };
          targetArea.appendChild(dlBtn);

          const note = document.createElement('div');
          note.style.cssText = 'margin-top:7px;font-size:10px;color:#475569;max-width:180px;line-height:1.35;';
          note.textContent = 'Secured table credential embedded. Keep this QR/NFC link at the intended table.';
          targetArea.appendChild(note);
        }, 150);
      } catch (error) {
        console.error('Secure table QR issuance failed:', error);
        targetArea.innerHTML = '';
        wrapper.style.display = 'none';
        alert('Could not issue a secured table QR. Check your tenant access and try again.');
      } finally {
        if (generateButton) {
          generateButton.disabled = false;
          generateButton.textContent = previousLabel;
        }
      }
    };
  }

  function statusLabel(status) {
    return String(status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function relativeTime(timestamp) {
    const created = new Date(timestamp).getTime();
    const minutes = Math.max(0, Math.floor((Date.now() - created) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes === 1) return '1 min ago';
    if (minutes < 60) return `${minutes} mins ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  function setBoardHealth(state) {
    const health = document.getElementById('tingOrdersHealth');
    if (!health) return;
    const stale = !lastSuccessfulRefreshAt || Date.now() - lastSuccessfulRefreshAt > RECONCILE_INTERVAL_MS * 2;
    const degraded = state === 'degraded' || lastRefreshFailed || stale;
    health.dataset.state = degraded ? 'degraded' : state;
    health.textContent = degraded ? 'Degraded' : state === 'live' ? 'Live' : 'Reconnecting';
  }

  function injectStyles() {
    if (document.getElementById('ting11c-order-board-style')) return;
    document.head.insertAdjacentHTML('beforeend', `
      <style id="ting11c-order-board-style">
        .ting-orders-section { margin: 0 0 26px; padding: 18px; background: #10172a; border: 1px solid var(--border-clr); border-radius: 14px; }
        .ting-orders-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; }
        .ting-orders-heading h2 { margin:0; font-size:17px; font-weight:800; }
        .ting-orders-heading-status { display:flex; align-items:center; gap:8px; }
        .ting-orders-health { font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; color:#86efac; border:1px solid #166534; background:rgba(22,101,52,.16); padding:4px 8px; border-radius:999px; }
        .ting-orders-health[data-state="reconnecting"] { color:#fde68a; border-color:#a16207; background:rgba(161,98,7,.16); }
        .ting-orders-health[data-state="degraded"] { color:#fecaca; border-color:#b91c1c; background:rgba(185,28,28,.16); }
        .ting-orders-count { font-size:11px; font-weight:800; color:#fdba74; border:1px solid #c2410c; background:rgba(194,65,12,.16); padding:4px 9px; border-radius:999px; }
        .ting-orders-grid { display:grid; grid-template-columns:1fr; gap:12px; }
        .ting-order-card { border:1px solid #334155; border-left:5px solid var(--accent); background:#131d36; border-radius:12px; padding:14px; }
        .ting-order-card[data-status="accepted"] { border-left-color:#3b82f6; }
        .ting-order-card[data-status="preparing"] { border-left-color:#f59e0b; }
        .ting-order-card[data-status="ready"] { border-left-color:#10b981; }
        .ting-order-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
        .ting-order-table { font-size:20px; font-weight:900; }
        .ting-order-meta { margin-top:2px; font-size:11px; color:#94a3b8; }
        .ting-order-status { font-size:10px; font-weight:900; text-transform:uppercase; letter-spacing:.06em; color:#cbd5e1; background:#0b1329; border:1px solid #475569; border-radius:999px; padding:5px 8px; }
        .ting-order-items { margin:12px 0; padding:10px 0; border-top:1px solid #334155; border-bottom:1px solid #334155; display:flex; flex-direction:column; gap:7px; }
        .ting-order-item { display:flex; justify-content:space-between; gap:10px; font-size:13px; }
        .ting-order-item-name { color:#e2e8f0; font-weight:700; }
        .ting-order-item-price { color:#94a3b8; white-space:nowrap; }
        .ting-order-footer { display:flex; justify-content:space-between; align-items:center; gap:10px; }
        .ting-order-total { font-size:15px; font-weight:900; }
        .ting-order-action { border:0; border-radius:8px; padding:9px 12px; background:var(--accent); color:white; font-weight:800; cursor:pointer; }
        .ting-order-action:disabled { opacity:.55; cursor:not-allowed; }
        .ting-orders-empty { padding:20px 10px; text-align:center; color:#64748b; font-size:13px; }
        .ting-orders-error { padding:12px; border:1px solid var(--danger); color:#fecaca; background:rgba(239,68,68,.08); border-radius:8px; font-size:12px; }
        @media (min-width: 700px) and (max-width: 1199px) { .ting-orders-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
      </style>`);
  }

  function injectBoardShell() {
    if (document.getElementById('tingOrdersSection')) return true;
    const pane = document.querySelector('.pane-main');
    const queue = document.getElementById('queue');
    if (!pane || !queue) return false;

    queue.insertAdjacentHTML('beforebegin', `
      <section id="tingOrdersSection" class="ting-orders-section" aria-live="polite">
        <div class="ting-orders-heading">
          <div>
            <h2>Restaurant Orders</h2>
            <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Live kitchen / FOH order queue</div>
          </div>
          <div class="ting-orders-heading-status">
            <div id="tingOrdersHealth" class="ting-orders-health" data-state="reconnecting">Reconnecting</div>
            <div id="tingOrdersCount" class="ting-orders-count">0 ACTIVE</div>
          </div>
        </div>
        <div id="tingOrdersGrid" class="ting-orders-grid">
          <div class="ting-orders-empty">Loading orders…</div>
        </div>
      </section>`);
    return true;
  }

  async function fetchActiveOrders(signal) {
    const { data: orders, error: orderError } = await supabaseInstance
      .from('orders')
      .select('id,tenant_id,table_number,status,total,created_at')
      .eq('tenant_id', tenantId)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true })
      .abortSignal(signal);

    if (orderError) throw orderError;
    if (!orders?.length) return [];

    const orderIds = orders.map(order => order.id);
    const { data: items, error: itemError } = await supabaseInstance
      .from('order_items')
      .select('order_id,tenant_id,item_name_snapshot,unit_price_snapshot,quantity,line_total')
      .eq('tenant_id', tenantId)
      .in('order_id', orderIds)
      .order('created_at', { ascending: true })
      .abortSignal(signal);

    if (itemError) throw itemError;
    const grouped = new Map();
    for (const item of items || []) {
      if (!grouped.has(item.order_id)) grouped.set(item.order_id, []);
      grouped.get(item.order_id).push(item);
    }

    return orders.map(order => ({ ...order, items: grouped.get(order.id) || [] }));
  }

  function renderOrders(orders) {
    const grid = document.getElementById('tingOrdersGrid');
    const count = document.getElementById('tingOrdersCount');
    if (!grid || !count) return;

    const focused = document.activeElement?.matches?.('[data-order-action]')
      ? {
          orderId: document.activeElement.dataset.orderId,
          nextStatus: document.activeElement.dataset.nextStatus
        }
      : null;

    count.textContent = `${orders.length} ACTIVE`;
    if (!orders.length) {
      grid.innerHTML = '<div class="ting-orders-empty">No active orders right now.</div>';
      return;
    }

    grid.innerHTML = orders.map(order => {
      const action = STATUS_ACTIONS[order.status];
      const itemMarkup = order.items.length
        ? order.items.map(item => `
            <div class="ting-order-item">
              <div class="ting-order-item-name">${Number(item.quantity)} × ${safeText(item.item_name_snapshot)}</div>
              <div class="ting-order-item-price">${money(item.line_total)}</div>
            </div>`).join('')
        : '<div class="ting-orders-empty" style="padding:4px;">No item details available.</div>';

      return `
        <article class="ting-order-card" data-status="${safeText(order.status)}" data-order-id="${safeText(order.id)}">
          <div class="ting-order-top">
            <div>
              <div class="ting-order-table">Table ${safeText(order.table_number)}</div>
              <div class="ting-order-meta">${relativeTime(order.created_at)} · ${safeText(order.id.slice(0, 8))}</div>
            </div>
            <div class="ting-order-status">${safeText(statusLabel(order.status))}</div>
          </div>
          <div class="ting-order-items">${itemMarkup}</div>
          <div class="ting-order-footer">
            <div class="ting-order-total">${money(order.total)}</div>
            ${action ? `<button class="ting-order-action" data-order-action data-order-id="${safeText(order.id)}" data-next-status="${safeText(action.next)}">${safeText(action.label)}</button>` : ''}
          </div>
        </article>`;
    }).join('');

    if (focused) {
      const matchingButton = Array.from(grid.querySelectorAll('[data-order-action]')).find(button =>
        button.dataset.orderId === focused.orderId && button.dataset.nextStatus === focused.nextStatus
      );
      matchingButton?.focus();
    }
  }

  async function refreshOrderBoard() {
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    refreshInFlight = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const orders = await fetchActiveOrders(controller.signal);
      renderOrders(orders);
      lastSuccessfulRefreshAt = Date.now();
      lastRefreshFailed = false;
      setBoardHealth(realtimeState === 'subscribed' ? 'live' : 'reconnecting');
    } catch (error) {
      lastRefreshFailed = true;
      console.error('TING-11C order board refresh failed:', error);
      setBoardHealth('degraded');
      const grid = document.getElementById('tingOrdersGrid');
      if (grid && !lastSuccessfulRefreshAt) {
        grid.innerHTML = '<div class="ting-orders-error">Orders could not be loaded. Refresh the dashboard or try again.</div>';
      }
    } finally {
      clearTimeout(timeoutId);
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        queueMicrotask(() => refreshOrderBoard());
      }
    }
  }

  async function advanceOrder(orderId, nextStatus, button) {
    if (!orderId || !nextStatus || !ACTIVE_STATUSES.includes(nextStatus) && nextStatus !== 'completed') return;
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Updating…';
    try {
      const { error } = await supabaseInstance.rpc('advance_order_status', {
        p_order_id: orderId,
        p_next_status: nextStatus
      });
      if (error) throw error;
      await refreshOrderBoard();
    } catch (error) {
      console.error('TING-11C status transition failed:', error);
      button.disabled = false;
      button.textContent = previousLabel;
      alert('Order status could not be updated. Please refresh and try again.');
    }
  }

  function bindBoardEvents() {
    const section = document.getElementById('tingOrdersSection');
    if (!section || section.dataset.bound === 'true') return;
    section.dataset.bound = 'true';
    section.addEventListener('click', event => {
      const button = event.target.closest('[data-order-action]');
      if (!button || button.disabled) return;
      advanceOrder(button.dataset.orderId, button.dataset.nextStatus, button);
    });
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') refreshOrderBoard();
  }

  function handleOnline() {
    setBoardHealth('reconnecting');
    refreshOrderBoard();
  }

  function startReconciliation() {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(() => {
      setBoardHealth(realtimeState === 'subscribed' ? 'live' : 'reconnecting');
      refreshOrderBoard();
    }, RECONCILE_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
  }

  function subscribeToOrders() {
    if (orderBoardChannel) supabaseInstance.removeChannel(orderBoardChannel);
    realtimeState = 'connecting';
    setBoardHealth('reconnecting');
    orderBoardChannel = supabaseInstance
      .channel(`orders:${tenantId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'orders',
        filter: `tenant_id=eq.${tenantId}`
      }, refreshOrderBoard)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `tenant_id=eq.${tenantId}`
      }, refreshOrderBoard)
      .subscribe(status => {
        realtimeState = status === 'SUBSCRIBED' ? 'subscribed' : 'connecting';
        setBoardHealth(status === 'SUBSCRIBED' ? 'live' : 'reconnecting');
        if (status === 'SUBSCRIBED') refreshOrderBoard();
      });
  }

  async function initOrderBoard() {
    if (boardInitialized) return;
    if (typeof supabaseInstance === 'undefined' || !supabaseInstance || typeof tenantId === 'undefined' || !tenantId) return;
    if (!injectBoardShell()) return;

    boardInitialized = true;
    injectStyles();
    bindBoardEvents();
    startReconciliation();
    subscribeToOrders();
    await refreshOrderBoard();
  }

  installSecureTableQrGenerator();

  const readinessTimer = setInterval(() => {
    try {
      if (document.getElementById('tingOrdersSection')) {
        clearInterval(readinessTimer);
        initOrderBoard();
        return;
      }
      if (document.querySelector('.pane-main') && document.getElementById('queue')) {
        initOrderBoard();
        if (boardInitialized) clearInterval(readinessTimer);
      }
    } catch (error) {
      console.error('TING-11C initialization isolated from admin shell:', error);
      clearInterval(readinessTimer);
    }
  }, 250);

  window.addEventListener('beforeunload', () => {
    if (pollingTimer) clearInterval(pollingTimer);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('online', handleOnline);
    if (orderBoardChannel && typeof supabaseInstance !== 'undefined' && supabaseInstance) {
      supabaseInstance.removeChannel(orderBoardChannel);
    }
  });
})();