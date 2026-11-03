-- PROPOSAL ONLY. Founder approval required before any production execution.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='menu_pictures_member_delete' AND cmd='DELETE' AND roles=ARRAY['authenticated']::name[] AND qual=$expected$((bucket_id = 'menu-pictures'::text) AND
CASE
    WHEN (name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'::text) THEN ting_private.can_manage_tenant((split_part(name, '/'::text, 1))::uuid)
    ELSE false
END)$expected$) THEN RAISE EXCEPTION 'SCHEMA-1 policy precondition changed; stop'; END IF;
END $guard$;
ALTER POLICY menu_pictures_member_delete ON storage.objects USING (((bucket_id = 'menu-pictures'::text) AND
CASE
    WHEN (name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'::text) THEN ting_private.can_manage_tenant((split_part(name, '/'::text, 1))::uuid)
    ELSE false
END));
COMMIT;
