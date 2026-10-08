import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const createIntent=read('api/payments/create-intent.js');
const webhook=read('api/payments/stripe-webhook.js');
const helper=read('lib/payments-server.js');
const db=read('supabase/migrations/20261008114500_pay2_processor_boundary.sql');
const abortDb=read('supabase/migrations/20261008114600_pay2_abort_unbound_attempt.sql');
const pkg=JSON.parse(read('package.json'));

assert.equal(pkg.dependencies.stripe,'23.0.0');
assert.equal(pkg.dependencies['raw-body'],'4.0.0');

assert.match(createIntent,/x-client-slug/);
assert.match(createIntent,/fn: 'create_payment_attempt'/);
assert.match(createIntent,/role: 'anon'/);
assert.match(createIntent,/moneyToMinorUnits\(attempt\.requested_amount\)/);
assert.match(createIntent,/idempotencyKey: `ting-attempt-\$\{attempt\.id\}`/);
assert.match(createIntent,/ting_attempt_id: attempt\.id/);
assert.match(createIntent,/ting_order_id: attempt\.order_id/);
assert.match(createIntent,/ting_tenant_id: attempt\.tenant_id/);
assert.match(createIntent,/fn: 'bind_payment_provider'/);
assert.match(createIntent,/abortCreatedAttempt/);
assert.match(createIntent,/cleanupStaleStripeAttempts/);
assert.match(createIntent,/if \(intent\.livemode\)/);
assert.doesNotMatch(createIntent,/tenant_id\s*:\s*(request|request\.body|body)/i);

assert.match(webhook,/bodyParser: false/);
assert.match(webhook,/getRawBody/);
assert.match(webhook,/constructEvent\(rawBody, signature, webhookSecret\(\)\)/);
assert.match(webhook,/if \(event\.livemode\)/);
assert.match(webhook,/payment_intent\.succeeded/);
assert.match(webhook,/payment_intent\.payment_failed/);
assert.match(webhook,/payment_intent\.canceled/);
assert.match(webhook,/confirmAttemptFromStripe/);
assert.match(webhook,/releaseAttempt/);

assert.match(helper,/STRIPE_SECRET_KEY/);
assert.match(helper,/STRIPE_WEBHOOK_SECRET/);
assert.match(helper,/SUPABASE_SERVICE_ROLE_KEY/);
assert.match(helper,/status: 'eq\.pending'/);
assert.match(helper,/stripe\.paymentIntents\.cancel/);
assert.match(helper,/Never release TinG balance if Stripe cancellation did not complete/);

assert.match(db,/a\.status = 'pending'/);
assert.match(db,/a\.status = 'created' AND a\.reservation_expires_at > now\(\)/);
assert.match(db,/AND status = 'created'\s+AND provider_payment_id IS NULL/);
assert.match(db,/GRANT EXECUTE ON FUNCTION public\.bind_payment_provider[\s\S]*TO service_role/);
assert.match(db,/GRANT EXECUTE ON FUNCTION public\.release_payment_attempt[\s\S]*TO service_role/);
assert.match(db,/GRANT EXECUTE ON FUNCTION public\.confirm_payment_attempt_trusted[\s\S]*TO service_role/);
assert.match(db,/payment provider reference mismatch/);
assert.match(db,/attempt\.status IN \('failed','cancelled','expired'\)/);
assert.match(abortDb,/only an unbound created payment attempt can be aborted/);
assert.match(abortDb,/GRANT EXECUTE ON FUNCTION public\.abort_created_payment_attempt[\s\S]*TO service_role/);

console.log('PASS: PAY-2 Stripe sandbox contract');
