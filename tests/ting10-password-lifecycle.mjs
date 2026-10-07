import fs from 'node:fs';

const admin = fs.readFileSync('admin.html', 'utf8');
const reset = fs.readFileSync('reset-password.html', 'utf8');

const mustContain = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
};
const mustNotContain = (source, needle, label) => {
  if (source.includes(needle)) throw new Error(`Unexpected ${label}: ${needle}`);
};

// Dependency pinning: current_password support is tied to supabase-js >= 2.102.0.
mustContain(admin, '@supabase/supabase-js@2.102.0', 'pinned supabase-js in admin');
mustContain(reset, '@supabase/supabase-js@2.102.0', 'pinned supabase-js in recovery page');

// Forgot-password requests must not disclose whether an account exists.
mustContain(admin, 'If an account exists for that email', 'generic recovery response');
mustContain(admin, 'resetPasswordForEmail(email', 'Supabase password reset call');
mustContain(admin, "recoveryUrl.searchParams.set('client', clientSlug)", 'tenant route preservation');
mustContain(admin, "(window.location.hash || '').replace(/^#/, '')", 'missing-hash-safe recovery parsing');
mustContain(admin, "fragment.get('type') !== 'recovery'", 'admin recovery-fragment guard');
mustContain(admin, "recoveryUrl.hash = window.location.hash", 'recovery token preservation');
mustContain(admin, "window.location.replace(recoveryUrl.toString())", 'admin recovery redirect');
mustContain(admin, "auth: { detectSessionInUrl: false }", 'admin refuses auth URL session consumption');
// Temporary preview bypasses must never ship or return to this flow.
mustNotContain(admin, '_vercel_share', 'temporary Vercel recovery bypass');

// Recovery must be proven by the actual recovery redirect token, not by an ordinary session.
mustContain(reset, "auth:{ skipAutoInitialize:true }", 'controlled auth initialization');
mustContain(reset, "recoveryFragment.get('type')", 'recovery type capture');
mustContain(reset, "recoveryFragment.get('access_token')", 'recovery token capture');
mustContain(reset, 'const { data:initData, error:initError } = await supabaseInstance.auth.initialize()', 'controlled recovery initialization');
mustContain(reset, "recoveryType === 'recovery'", 'recovery type proof');
mustContain(reset, 'Boolean(recoveryAccessToken)', 'non-empty recovery token proof');
mustContain(reset, 'Boolean(initializedSession?.access_token)', 'initialized session token proof');
mustContain(reset, 'initializedSession.access_token === recoveryAccessToken', 'exact recovery token/session match');
mustContain(reset, 'if (!hasVerifiedRecoveryProof)', 'fail-closed recovery proof');
mustContain(reset, 'if (!recoveryAuthorized || !supabaseInstance)', 'fail-closed submit guard');
mustNotContain(reset, "event === 'PASSWORD_RECOVERY'", 'event-only recovery authorization');

// Password replacement and authenticated password change.
mustContain(reset, 'auth.updateUser({ password })', 'recovery password update');
mustContain(admin, 'current_password: currentPassword', 'current-password verification');

// TING-8 authorization gate must remain in front of the admin workspace.
mustContain(admin, "rpc('can_manage_current_tenant')", 'tenant membership RPC');
mustContain(admin, 'if (membershipError || canManageTenant !== true)', 'fail-closed membership gate');
mustContain(admin, 'renderTenantAccessDenied()', 'access denied path');

console.log('TING-10 password lifecycle static security checks passed.');
