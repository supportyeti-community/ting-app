import Stripe from 'stripe';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function stripeClient() {
  return new Stripe(requiredEnv('STRIPE_SECRET_KEY'));
}

export function webhookSecret() {
  return requiredEnv('STRIPE_WEBHOOK_SECRET');
}

export function supabaseConfig() {
  return {
    url: requiredEnv('SUPABASE_URL').replace(/\/$/, ''),
    anonKey: requiredEnv('SUPABASE_ANON_KEY'),
    serviceKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error_description || data?.hint || `Supabase request failed (${response.status})`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export async function supabaseRpc({ fn, body, role = 'service', clientSlug }) {
  const { url, anonKey, serviceKey } = supabaseConfig();
  const key = role === 'anon' ? anonKey : serviceKey;
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  };
  if (clientSlug) headers['x-client-slug'] = clientSlug;
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  return parseJsonResponse(response);
}

export async function supabaseSelect({ table, query, role = 'service' }) {
  const { url, anonKey, serviceKey } = supabaseConfig();
  const key = role === 'anon' ? anonKey : serviceKey;
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      accept: 'application/json',
    },
  });
  return parseJsonResponse(response);
}

export function oneRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

export function moneyToMinorUnits(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('Invalid payment amount');
  const cents = Math.round(numeric * 100);
  if (Math.abs(cents / 100 - numeric) > 0.000001) throw new Error('Payment amount must have at most two decimal places');
  return cents;
}

export function minorUnitsToMoney(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) throw new Error('Invalid processor amount');
  return numeric / 100;
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isStripeAccountId(value) {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value);
}

export async function resolveStripeConnectedAccount(tenantId) {
  if (!isUuid(tenantId)) throw new Error('Invalid canonical tenant id');
  const query = new URLSearchParams({
    select: 'provider_account_id,status',
    tenant_id: `eq.${tenantId}`,
    provider: 'eq.stripe',
    status: 'eq.active',
    limit: '2',
  }).toString();
  const rows = await supabaseSelect({ table: 'tenant_payment_accounts', query });
  if (!Array.isArray(rows) || rows.length !== 1 || !isStripeAccountId(rows[0].provider_account_id)) {
    throw new Error('Active Stripe connected account unavailable for tenant');
  }
  return rows[0].provider_account_id;
}

export async function abortCreatedAttempt({ attemptId, failureCode, failureMessage }) {
  return oneRow(await supabaseRpc({
    fn: 'abort_created_payment_attempt',
    body: {
      p_attempt_id: attemptId,
      p_failure_code: failureCode || null,
      p_failure_message: failureMessage || null,
    },
  }));
}

export async function releaseAttempt({ attemptId, providerAccountId, providerPaymentId, terminalStatus, failureCode, failureMessage }) {
  if (!isStripeAccountId(providerAccountId)) throw new Error('Invalid Stripe connected account context');
  return oneRow(await supabaseRpc({
    fn: 'release_payment_attempt',
    body: {
      p_attempt_id: attemptId,
      p_provider: 'stripe',
      p_provider_account_id: providerAccountId,
      p_provider_payment_id: providerPaymentId,
      p_terminal_status: terminalStatus,
      p_failure_code: failureCode || null,
      p_failure_message: failureMessage || null,
    },
  }));
}

export async function confirmAttemptFromStripe(intent, providerAccountId) {
  const attemptId = intent?.metadata?.ting_attempt_id;
  if (!isUuid(attemptId)) throw new Error('Stripe PaymentIntent missing canonical TinG attempt id');
  if (!isStripeAccountId(providerAccountId)) throw new Error('Stripe event missing connected account context');
  return oneRow(await supabaseRpc({
    fn: 'confirm_payment_attempt_trusted',
    body: {
      p_attempt_id: attemptId,
      p_provider: 'stripe',
      p_provider_account_id: providerAccountId,
      p_provider_payment_id: intent.id,
      p_confirmed_amount: minorUnitsToMoney(intent.amount_received),
      p_currency: String(intent.currency || '').toUpperCase(),
    },
  }));
}

export async function cleanupStaleStripeAttempts(orderId, stripe) {
  if (!isUuid(orderId)) return;
  const query = new URLSearchParams({
    select: 'id,provider_account_id,provider_payment_id,status,reservation_expires_at',
    order_id: `eq.${orderId}`,
    provider: 'eq.stripe',
    status: 'eq.pending',
    reservation_expires_at: `lte.${new Date().toISOString()}`,
  }).toString();
  const rows = await supabaseSelect({ table: 'payment_attempts', query });

  for (const row of rows || []) {
    if (!row.provider_payment_id || !isStripeAccountId(row.provider_account_id)) {
      throw new Error('Stale Stripe attempt missing canonical connected-account binding');
    }
    const stripeAccount = row.provider_account_id;
    const intent = await stripe.paymentIntents.retrieve(row.provider_payment_id, {}, { stripeAccount });
    if (intent.livemode) throw new Error('Live Stripe PaymentIntent encountered during PAY-2 sandbox cleanup');

    if (intent.status === 'succeeded') {
      await confirmAttemptFromStripe(intent, stripeAccount);
      continue;
    }

    let cancelled = intent;
    if (intent.status !== 'canceled') {
      try {
        cancelled = await stripe.paymentIntents.cancel(intent.id, {}, { stripeAccount });
      } catch (error) {
        throw new Error(`Unable to cancel stale Stripe PaymentIntent ${intent.id}: ${error.message}`);
      }
    }

    if (cancelled.status !== 'canceled') throw new Error(`Stripe PaymentIntent ${intent.id} was not cancelled`);
    await releaseAttempt({
      attemptId: row.id,
      providerAccountId: stripeAccount,
      providerPaymentId: intent.id,
      terminalStatus: 'expired',
      failureCode: 'reservation_timeout',
      failureMessage: 'Processor-bound reservation expired and Stripe PaymentIntent was cancelled before release.',
    });
  }
}
