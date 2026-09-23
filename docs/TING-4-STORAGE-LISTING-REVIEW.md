# TING-4 — restrict `menu-pictures` listing (draft release review)

## Scope and current boundary

The current `storage.objects` SELECT policy allows both `anon` and `authenticated` to list all names in the public `menu-pictures` bucket. This migration replaces that policy with one allowing only authenticated members of the existing `admin_users` allowlist to SELECT. It does not change the bucket's public flag, object paths, existing `menu_items.image_url` values, or INSERT/UPDATE/DELETE policies. The frontend uses unique names with `upsert:false`, which requires INSERT only. Existing known `/object/public/menu-pictures/...` URLs remain served by the public bucket.

This closes public object-name enumeration. A public object URL remains shareable, and a global platform admin can still list every object in this bucket. Tenant paths, tenant-scoped write authorization, deletion cleanup and second-tenant provisioning remain TING-8 work. Do not use this change as second-tenant launch approval.

## Migration and preflight

`20260923194905_ting4_restrict_menu_picture_listing.sql` runs in one transaction, sets a five-second lock timeout and a thirty-second statement timeout, and refuses to proceed unless exactly four Storage policies exist, the old SELECT policy has the expected roles and predicate, and the bucket is public. Postcondition checks the replacement policy and four-policy count. A changed live policy, added Storage policy or private bucket requires review before rollout.

Review live state again immediately before rollout: GitHub `main`/deployed SHA, migration ledger, the four exact `storage.objects` policies, public bucket configuration, existing object names and referencing image URLs. Apply the migration via the approved migration route only after production approval; do not run the test harness against production. Verify policy roles, anonymous and ordinary list denial, admin listing, one existing public image URL, unique admin upload, and unchanged object/reference counts. Merge the reviewed head only with separate approval.

## Verification

- `node supabase/tests/ting4/storage-listing.mjs` passed locally on disposable PGlite: baseline disclosure, policy drift rejection with rollback, role-specific SELECT, write-policy equality, bucket/object preservation, and repeat-apply rejection.
- The native CI workflow creates a disposable local Supabase instance, restores the baseline, rehearses fifteen prior ledger versions plus CLI dry-run/apply/no-op, and checks real Storage list, public download and upload behavior. It must pass on the draft PR before production consideration. Docker is unavailable in the authoring workspace, so the native test has not been run locally.
- There were no production database, Storage object, Vercel or Notion mutations during draft preparation.

## Recovery if an approved rollout fails

The migration is atomic: preflight, policy replacement and verification commit together or roll back together. If application succeeds but Storage behavior is wrong, restore the original SELECT policy in a separately reviewed rollback migration after checking the live policy state:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP POLICY "Admins can list menu pictures" ON storage.objects;
CREATE POLICY "Public can view menu pictures" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'menu-pictures');
COMMIT;
```

That rollback reopens public listing. Treat it as a temporary recovery action and retain TING-4 open until the disclosure is resolved.
