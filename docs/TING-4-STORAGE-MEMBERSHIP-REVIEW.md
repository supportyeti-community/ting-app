# TING-4 — tenant-member Storage policy, review draft

This migration is **not applied to production**. It replaces the four global
`is_admin()` policies on `storage.objects` for `menu-pictures` with member-scoped
INSERT, SELECT and DELETE; client UPDATE is intentionally removed. The existing
`ting_private.can_manage_tenant(uuid)` checks authenticated owner/admin membership
in the private registry, not a route slug, header, or user-editable JWT metadata.

New paths must be exactly `<canonical-lowercase-tenant-uuid>/<canonical-lowercase-random-uuid>.jpg|png`.
The prefix is caller-controlled and never trusted alone. A Bistro owner can
list/read existing flat paths, but no browser user can create, replace or delete
flat objects. The public bucket and existing public URLs remain unchanged;
public assets are not confidential. Cross-prefix UPDATE/move and upsert are not
supported, consistent with the deployed `upsert:false` uploader.

## Production preflight (read only)

2026-09-24: one tenant (`the-bistro`, UUID pinned in the migration preflight),
one owner membership, five flat objects and one prefixed object. Four current
Storage policies use `is_admin()`; public bucket is true. Through the deployed
admin UI, the owner published the user-approved `Thakali Set` item at $25 with
the supplied JPEG. The browser uploaded a 94,402-byte JPEG under
`d8e68393-70de-4e77-8c07-51992f2b64a6/e0a69779-3f79-42e9-8377-d549fdd7f0b8.jpg`.
The item and photo appear on Bistro's public menu, and the stored menu-item URL
points to this prefixed object. This verifies the current uploader before the
policy cutover; it does not exercise the new production policy yet.

The migration aborts if a policy name/command/expression changes, or if the
existing membership helper is absent, is no longer security definer, cannot
be executed by `authenticated`, or can be executed by `anon`. Read-only live
inspection on 2026-09-24 found the expected four policies and helper grants;
repeat this immediately before the release. Its caller still needs a valid
owner/admin membership, as checked in the private helper body.

## Release gate

1. Disposable PGlite and native Storage/Auth checks passed in PR #13 CI.
   The native runner requires Docker, which is unavailable in this workspace.
2. Cutover decision (2026-09-24): keep the strict policy with **no flat-upload
   fallback**. Require admins to reload open dashboard tabs at release. An old
   tab may fail an upload until refreshed; communicate and monitor this explicitly.
3. Live upload completed with the approved Bistro dish and photo. Do not create
   another production item solely for repeated checks. After the cutover,
   verify owner listing of the prefixed and legacy objects and public rendering
   of both images using the existing records.
4. Before any production apply, verify the live policy fingerprints, bucket,
   Bistro UUID/membership, object counts, and live UI uploader version again.
   Apply only after explicit release review and tenant A/B and revocation checks
   on the disposable stack. Keep TING-4 open until post-cutover checks are
   complete, and keep TING-8's second-tenant onboarding block independent.

Rollback requires a reviewed reverse policy migration. Reverting the frontend
alone after this strict policy would make uploads fail; no automatic broad
`is_admin()` fallback should be restored without separate approval.
