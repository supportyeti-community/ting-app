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
one owner membership, five flat objects and zero prefixed objects. Four current
Storage policies use `is_admin()`; public bucket is true. No production object
was created for this review. A real admin upload through the deployed UI has
**not** yet been verified.

## Release gate

1. Review disposable PGlite and native Storage/Auth checks. The native runner
   requires Docker and runs in CI; Docker is unavailable in this workspace.
2. Decide the cached-admin-page cutover. This strict migration rejects flat
   uploads from older open admin tabs. Either require a reload/window and accept
   that failure mode, or revise the migration with a time-limited,
   Bistro-only membership-and-platform-admin fallback, then rehearse it.
3. Before any production apply, verify the live policy fingerprints, bucket,
   Bistro UUID/membership, object counts, and live UI uploader version again.
   Apply only after explicit release review; exercise a new Bistro upload and
   public URL afterward, plus tenant A/B and revocation checks on the disposable
   stack. Keep TING-4 open until this is complete, and keep TING-8's second-tenant
   onboarding block independent.

Rollback requires a reviewed reverse policy migration. Reverting the frontend
alone after this strict policy would make uploads fail; no automatic broad
`is_admin()` fallback should be restored without separate approval.
