import {
  cleanupStaleStripeAttempts,
  isUuid,
  moneyToMinorUnits,
  oneRow,
  stripeClient,
  supabaseRpc,
} from '../../lib/payments-server.js';

function badRequest(response, message) {
  return response.status(400).json({ error: message });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const clientSlug = String(request.headers['x-client-slug'] || '').trim();
  const { order_id: orderId, requested_amount: requestedAmount, client_request_id: clientRequestId } = request.body || {};

  if (!clientSlug) return badRequest(response, 'Missing tenant route');
  if (!isUuid(orderId) || !isUuid(clientRequestId)) return badRequest(response, 'Invalid payment request identifiers');

  let requestedCents;
  try { requestedCents = moneyToMinorUnits(requestedAmount); }
  catch (error) { return badRequest(response, error.message); }

  try {
    const stripe = stripeClient();
    await cleanupStaleStripeAttempts(orderId, stripe);

    const attempt = oneRow(await supabaseRpc({
      fn: 'create_payment_attempt',
      role: 'anon',
      clientSlug,
      body: {
        p_order_id: orderId,
        p_requested_amount: requestedAmount,
        p_client_request_id: clientRequestId,
      },
    }));

    if (!attempt?.id) throw new Error('Canonical payment attempt was not returned');
    const canonicalCents = moneyToMinorUnits(attempt.requested_amount);
    if (canonicalCents !== requestedCents) throw new Error('Canonical payment amount mismatch');

    if (attempt.status === 'pending') {
      if (attempt.provider !== 'stripe' || !attempt.provider_payment_id) throw new Error('Existing pending payment uses an unexpected provider binding');
      const existingIntent = await stripe.paymentIntents.retrieve(attempt.provider_payment_id);
      if (existingIntent.livemode) throw new Error('Live Stripe PaymentIntent encountered during PAY-2 sandbox');
      if (existingIntent.amount !== canonicalCents || existingIntent.currency !== 'aud') throw new Error('Existing Stripe PaymentIntent amount/currency mismatch');
      return response.status(200).json({
        payment_attempt_id: attempt.id,
        client_secret: existingIntent.client_secret,
        amount: attempt.requested_amount,
        currency: attempt.currency,
        reused: true,
      });
    }

    if (attempt.status !== 'created') return response.status(409).json({ error: `Payment attempt is ${attempt.status}` });

    const intent = await stripe.paymentIntents.create({
      amount: canonicalCents,
      currency: 'aud',
      automatic_payment_methods: { enabled: true },
      metadata: {
        ting_attempt_id: attempt.id,
        ting_order_id: attempt.order_id,
        ting_tenant_id: attempt.tenant_id,
      },
    }, {
      idempotencyKey: `ting-attempt-${attempt.id}`,
    });

    if (intent.livemode) {
      try { await stripe.paymentIntents.cancel(intent.id); } catch {}
      throw new Error('PAY-2 sandbox refused a live-mode PaymentIntent');
    }

    let bound;
    try {
      bound = oneRow(await supabaseRpc({
        fn: 'bind_payment_provider',
        body: {
          p_attempt_id: attempt.id,
          p_provider: 'stripe',
          p_provider_payment_id: intent.id,
        },
      }));
    } catch (error) {
      try { await stripe.paymentIntents.cancel(intent.id); } catch {}
      throw error;
    }

    return response.status(200).json({
      payment_attempt_id: bound.id,
      client_secret: intent.client_secret,
      amount: bound.requested_amount,
      currency: bound.currency,
      reused: false,
    });
  } catch (error) {
    console.error('PAY-2 create-intent failed', { message: error.message, status: error.status || null });
    return response.status(error.status && error.status < 500 ? error.status : 500).json({ error: 'Unable to start payment' });
  }
}
