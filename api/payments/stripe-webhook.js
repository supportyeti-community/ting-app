import getRawBody from 'raw-body';
import {
  confirmAttemptFromStripe,
  isStripeAccountId,
  isUuid,
  releaseAttempt,
  stripeClient,
  webhookSecret,
} from '../../lib/payments-server.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function cancelFailedIntent(stripe, intent, connectedAccountId) {
  if (intent.status === 'canceled' || intent.status === 'succeeded') return intent;
  return stripe.paymentIntents.cancel(intent.id, {}, { stripeAccount: connectedAccountId });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const signature = request.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') return response.status(400).json({ error: 'Missing Stripe signature' });

  let event;
  try {
    const stripe = stripeClient();
    const rawBody = await getRawBody(request, { limit: '1mb' });
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret());

    if (event.livemode) return response.status(400).json({ error: 'Live Stripe events are disabled during PAY-2 sandbox' });

    const connectedAccountId = event.account;
    if (!isStripeAccountId(connectedAccountId)) {
      throw new Error('Stripe Connect event missing connected account id');
    }

    const intent = event.data?.object;
    if (!intent || intent.object !== 'payment_intent') return response.status(200).json({ received: true, ignored: true });

    const attemptId = intent.metadata?.ting_attempt_id;
    if (!isUuid(attemptId)) throw new Error('Stripe event missing canonical TinG payment attempt id');

    switch (event.type) {
      case 'payment_intent.succeeded':
        await confirmAttemptFromStripe(intent, connectedAccountId);
        break;

      case 'payment_intent.payment_failed': {
        const cancelled = await cancelFailedIntent(stripe, intent, connectedAccountId);
        if (cancelled.status !== 'canceled') throw new Error('Failed PaymentIntent could not be cancelled before releasing TinG reservation');
        await releaseAttempt({
          attemptId,
          providerAccountId: connectedAccountId,
          providerPaymentId: intent.id,
          terminalStatus: 'failed',
          failureCode: intent.last_payment_error?.code || 'payment_failed',
          failureMessage: intent.last_payment_error?.message || 'Stripe reported payment failure.',
        });
        break;
      }

      case 'payment_intent.canceled':
        await releaseAttempt({
          attemptId,
          providerAccountId: connectedAccountId,
          providerPaymentId: intent.id,
          terminalStatus: 'cancelled',
          failureCode: intent.cancellation_reason || 'processor_cancelled',
          failureMessage: 'Stripe PaymentIntent was cancelled.',
        });
        break;

      default:
        return response.status(200).json({ received: true, ignored: true });
    }

    return response.status(200).json({ received: true });
  } catch (error) {
    console.error('PAY-2 Stripe webhook rejected', {
      message: error.message,
      eventType: event?.type || null,
      connectedAccountId: event?.account || null,
    });
    return response.status(400).json({ error: 'Webhook rejected' });
  }
}
