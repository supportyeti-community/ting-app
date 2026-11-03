-- Historical production predicate reproduced ONLY on a disposable local target.
ALTER POLICY menu_pictures_member_delete ON storage.objects USING (((bucket_id = 'menu-pictures'::text) AND
CASE
    WHEN (name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'::text) THEN ting_private.can_manage_tenant((split_part(name, '/'::text, 1))::uuid)
    ELSE false
END));
