# TING-4 — tenant path contract, first compatibility slice

## Scope

New menu image uploads use `menu-pictures/<tenant_uuid>/<random_uuid>.<ext>`, where both UUIDs are canonical lowercase, hyphenated values and `<ext>` is derived from the compressed image MIME (`image/jpeg` → `jpg`, `image/png` → `png`). The leading UUID comes from the already resolved `request_tenant_id()` route; it is **not** proof of authorization. The browser sends the same path to `upload(..., {upsert:false})` and `getPublicUrl()`, and writes the resulting URL to `menu_items.image_url`.

Storage RLS must later check the leading UUID against authenticated `tenant_memberships` (owner/admin), regardless of a caller-controlled path, header, slug or JWT user metadata. A route slug alone must never grant Storage writes. A missing or invalid UUID fails before the upload, and unsupported compressed MIME fails closed.

## Compatibility boundary

This PR changes the uploader only. The existing production `INSERT` policy still uses the platform-wide `is_admin()` allowlist and accepts arbitrary paths. A prefixed upload working under that policy is a **compatibility test, not a tenant-isolation test**. It remains possible for a platform admin to choose a foreign prefix until the later policy release. Do not onboard a second tenant or close TING-4 after this PR alone.

Five existing Bistro objects have flat names. They and their existing public URLs stay untouched; the frontend does not list objects or delete them when a menu item is removed. The public bucket intentionally serves anyone who knows a URL, including one embedded in the public menu. These images must be treated as public content, not confidential tenant files. Existing flat objects may be maintained by trusted operators without moving or rewriting `menu_items.image_url`.

## Tests and release order

`supabase/tests/ting4/upload-path.mjs` exercises both tenant UUIDs, random filenames, MIME-derived extensions, malformed inputs, and use of one path for upload and public URL. The disposable native Supabase test uploads a tenant-prefixed object under the current policy and retrieves its public bytes. Existing TING-2 frontend and TING-4 policy suites remain required.

1. Review this isolated draft. On separate approval, merge/deploy the uploader and verify a new Bistro menu image and its public URL. No production object is created as part of this draft.
2. In a separate release, preflight the live bucket, old flat objects, memberships and policies, then stage a Storage RLS migration that permits only membership-scoped UUID paths for new writes. Preserve known public URLs and an explicit legacy-flat read for existing Bistro images; do not allow client-side object moves across prefixes. Test A/B membership, forged slug/metadata, revocation, anonymous listing, legacy URL and upload/upsert behavior on a disposable native stack.
3. Only after that migration, a live admin upload test, and TING-8 provisioning review can the Storage tenant boundary be considered for closure. Public URL confidentiality is not promised by this contract.

Rollback of this frontend slice is to restore the previous uploader while the old INSERT policy remains; the later policy migration must not be applied first because it would reject flat uploads from a cached admin page. Cached pages are a release compatibility concern: the later policy must either temporarily allow **Bistro-only** flat writes for the existing platform admin or wait until the cached-page risk is explicitly accepted and monitored. Do not silently broaden that fallback to new tenants.
