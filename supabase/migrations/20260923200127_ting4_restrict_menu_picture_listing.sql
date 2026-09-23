-- TING-4: close anonymous menu-pictures enumeration while retaining public URLs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects') <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Public can view menu pictures'
         AND cmd = 'SELECT' AND permissive = 'PERMISSIVE'
         AND roles = ARRAY['anon', 'authenticated']::name[]
         AND qual = '(bucket_id = ''menu-pictures''::text)'
         AND with_check IS NULL)
     OR (SELECT public FROM storage.buckets WHERE id = 'menu-pictures') IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'TING-4 Storage policy/bucket preflight drift';
  END IF;
END $preflight$;

DROP POLICY "Public can view menu pictures" ON storage.objects;
CREATE POLICY "Admins can list menu pictures" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'menu-pictures' AND public.is_admin());

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects') <> 4
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'Admins can list menu pictures'
         AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
         AND qual = '((bucket_id = ''menu-pictures''::text) AND is_admin())')
     OR (SELECT public FROM storage.buckets WHERE id = 'menu-pictures') IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'TING-4 Storage policy verification failed';
  END IF;
END $verify$;
COMMIT;
