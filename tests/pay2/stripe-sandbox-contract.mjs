import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const createIntent=read('api/payments/create-intent.js');
const webhook=read('api/payments/stripe-webhook.js');
const helper=read('lib/payments-server.js');
const db=read('supabase/migrations/20261008114500_pay2_processor_boundary.sql');
const abortDb=read('supabase/migrations/20261008114600_pay2_abort_unbound_attempt.sql');
const connectDb=read('supabase/migrations/20261008120500_pay2_connect_direct_charges.sql');
const design=read('docs/PAY-2-DESIGN.md');
const pkg=JSON.parse(read('package.json'));

assert.equal(pkg.dependencies.stripe,'23.0.0');
assert.equal(pkg.dependencies['raw-body'],'4.0.0');

assert.match(design,/Stripe Connect direct charges/);
assert.match(design,/restaurant connected account/);
assert.match(design,/does not use destination charges or separate charges\/transfers/);

assert.match(createIntent,/x-client-slug/);
assert.match(createIntent,/fn: 'create_payment_attempt'/);
assert.match(createIntent,/role: 'anon'/);
assert.match(createIntent,/resolveStripeConnectedAccount\(attempt\.tenant_id\)/);
assert.match(createIntent,/moneyToMinorUnits\(attempt\.requested_amount\)/);
assert.match(createIntent,/stripeAccount: connectedAccountId/);
assert.match(createIntent,/idempotencyKey: `ting-attempt-\$\{attempt\.id\}`/);
assert.match(createIntent,/ting_attempt_id: attempt\.id/);
assert.match(createIntent,/ting_order_id: attempt\.order_id/);
assert.match(createIntent,/ting_tenant_id: attempt\.tenant_id/);
assert.match(createIntent,/p_provider_account_id: connectedAccountId/);
assert.match(createIntent,/connected_account_id: connectedAccountId/);
assert.match(createIntent,/abortCreatedAttempt/);
assert.match(createIntent,/cleanupStaleStripeAttempts/);
assert.match(createIntent,/if \(intent\.livemode\)/);
assert.doesNotMatch(createIntent,/tenant_id\s*:\s*(request|request\.body|body)/i);
assert.doesNotMatch(createIntent,/provider_account_id\s*:\s*(request|request\.body|body)/i);

assert.match(webhook,/bodyParser: false/);
assert.match(webhook,/getRawBody/);
assert.match(webhook,/constructEvent\(rawBody, signature, webhookSecret\(\)\)/);
assert.match(webhook,/if \(event\.livemode\)/);
assert.match(webhook,/const connectedAccountId = event\.account/);
assert.match(webhook,/isStripeAccountId\(connectedAccountId\)/);
assert.match(webhook,/payment_intent\.succeeded/);
assert.match(webhook,/payment_intent\.payment_failed/);
assert.match(webhook,/payment_intent\.canceled/);
assert.match(webhook,/confirmAttemptFromStripe\(intent, connectedAccountId\)/);
assert.match(webhook,/providerAccountId: connectedAccountId/);
assert.match(webhook,/stripeAccount: connectedAccountId/);

assert.match(helper,/STRIPE_SECRET_KEY/);
assert.match(helper,/STRIPE_WEBHOOK_SECRET/);
assert.match(helper,/SUPABASE_SERVICE_ROLE_KEY/);
assert.match(helper,/tenant_payment_accounts/);
assert.match(helper,/provider_account_id/);
assert.match(helper,/stripeAccount/);
assert.match(helper,/status: 'eq\.pending'/);
assert.match(helper,/Never release TinG balance if Stripe cancellation did not complete|Unable to cancel stale Stripe PaymentIntent/);

assert.match(db,/a\.status = 'pending'/);
assert.match(db,/a\.status = 'created' AND a\.reservation_expires_at > now\(\)/);
assert.match(db,/AND status = 'created'\s+AND provider_payment_id IS NULL/);
assert.match(abortDb,/only an unbound created payment attempt can be aborted/);
assert.match(abortDb,/GRANT EXECUTE ON FUNCTION public\.abort_created_payment_attempt[\s\S]*TO service_role/);

assert.match(connectDb,/CREATE TABLE IF NOT EXISTS public\.tenant_payment_accounts/);
assert.match(connectDb,/UNIQUE \(tenant_id, provider\)/);
assert.match(connectDb,/UNIQUE \(provider, provider_account_id\)/);
assert.match(connectDb,/ADD COLUMN IF NOT EXISTS provider_account_id text/);
assert.match(connectDb,/REVOKE ALL ON TABLE public\.tenant_payment_accounts FROM PUBLIC, anon, authenticated/);
assert.match(connectDb,/DROP FUNCTION IF EXISTS public\.bind_payment_provider\(uuid,text,text\)/);
assert.match(connectDb,/p_provider_account_id text/);
assert.match(connectDb,/tenant payment account unavailable/);
assert.match(connectDb,/attempt\.provider_account_id/);
assert.match(connectDb,/GRANT EXECUTE ON FUNCTION public\.bind_payment_provider\(uuid,text,text,text\)[\s\S]*TO service_role/);
assert.match(connectDb,/GRANT EXECUTE ON FUNCTION public\.release_payment_attempt\(uuid,text,text,text,text,text,text\)[\s\S]*TO service_role/);
assert.match(connectDb,/GRANT EXECUTE ON FUNCTION public\.confirm_payment_attempt_trusted\(uuid,text,text,text,numeric,text\)[\s\S]*TO service_role/);

console.log('PASS: PAY-2 Stripe Connect direct-charge sandbox contract');
