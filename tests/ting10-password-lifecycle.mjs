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

// Recovery must be authorized by Supabase auth state, never URL/session inference.
mustContain(reset, "event === 'PASSWORD_RECOVERY'", 'PASSWORD_RECOVERY gate');
mustContain(reset, 'if (!recoveryAuthorized || !supabaseInstance)', 'fail-closed submit guard');
mustNotContain(reset, 'hasRecoveryEvidence', 'URL-based recovery authorization');
mustNotContain(reset, 'session &&', 'ordinary session recovery authorization');

// Password replacement and authenticated password change.
mustContain(reset, 'auth.updateUser({ password })', 'recovery password update');
mustContain(admin, 'current_password: currentPassword', 'current-password verification');

// TING-8 authorization gate must remain in front of the admin workspace.
mustContain(admin, "rpc('can_manage_current_tenant')", 'tenant membership RPC');
mustContain(admin, 'if (membershipError || canManageTenant !== true)', 'fail-closed membership gate');
mustContain(admin, 'renderTenantAccessDenied()', 'access denied path');

console.log('TING-10 password lifecycle static security checks passed.');
