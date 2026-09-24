-- Review-only TING-4 release. Apply after the prefixed uploader is deployed and
-- cached legacy admin pages are accepted/expired; old flat objects remain public.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects') <> 4
     OR (SELECT count(*) FROM pg_policies
         WHERE schemaname='storage' AND tablename='objects'
           AND policyname IN ('Admins can delete menu pictures',
                              'Admins can list menu pictures',
                              'Admins can update menu pictures',
                              'Admins can upload menu pictures')
           AND roles=ARRAY['authenticated']::name[]
           AND permissive='PERMISSIVE'
           AND qual='((bucket_id = ''menu-pictures''::text) AND is_admin())'
           AND (cmd <> 'UPDATE' OR with_check=qual)
           AND (cmd <> 'INSERT' OR with_check=qual)) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_policies
         WHERE schemaname='storage' AND tablename='objects'
           AND policyname='Admins can upload menu pictures' AND cmd='INSERT'
           AND roles=ARRAY['authenticated']::name[] AND qual IS NULL
           AND with_check='((bucket_id = ''menu-pictures''::text) AND is_admin())')
     OR (SELECT public FROM storage.buckets WHERE id='menu-pictures') IS DISTINCT FROM true
     OR (SELECT id FROM public.tenants WHERE client_slug='the-bistro')
          IS DISTINCT FROM 'd8e68393-70de-4e77-8c07-51992f2b64a6'::uuid
     OR to_regprocedure('ting_private.can_manage_tenant(uuid)') IS NULL
  THEN RAISE EXCEPTION 'TING-4 membership policy preflight drift';
  END IF;
END $preflight$;

DROP POLICY "Admins can delete menu pictures" ON storage.objects;
DROP POLICY "Admins can list menu pictures" ON storage.objects;
DROP POLICY "Admins can update menu pictures" ON storage.objects;
DROP POLICY "Admins can upload menu pictures" ON storage.objects;

-- Only exactly two canonical components: tenant UUID / random UUID.jpg|png.
-- The CASE guards the cast even when the path is malformed.
CREATE POLICY menu_pictures_member_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id='menu-pictures' AND
    CASE WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'
      THEN ting_private.can_manage_tenant(split_part(name,'/',1)::uuid)
      ELSE false END
  );
CREATE POLICY menu_pictures_member_select ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id='menu-pictures' AND (
      CASE WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'
        THEN ting_private.can_manage_tenant(split_part(name,'/',1)::uuid)
        ELSE false END
      OR (position('/' in name)=0 AND
          ting_private.can_manage_tenant('d8e68393-70de-4e77-8c07-51992f2b64a6'::uuid))
    )
  );
CREATE POLICY menu_pictures_member_delete ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id='menu-pictures' AND
    CASE WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'
      THEN ting_private.can_manage_tenant(split_part(name,'/',1)::uuid)
      ELSE false END
  );
-- Intentionally no UPDATE: the app uses upsert:false; client-side moves and
-- replacements are not required. Trusted operators can maintain legacy files.

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects') <> 3
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='storage'
           AND tablename='objects' AND policyname IN
           ('menu_pictures_member_insert','menu_pictures_member_select','menu_pictures_member_delete')) <> 3
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage'
           AND tablename='objects' AND cmd='UPDATE')
  THEN RAISE EXCEPTION 'TING-4 membership policy verification failed'; END IF;
END $verify$;
COMMIT;
