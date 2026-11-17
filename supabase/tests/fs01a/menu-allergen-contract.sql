-- FS-01A disposable-only SQL assertions, run AFTER migration in a rollback transaction.
-- Existing test suite should provision tenant A/B and users via its native harness.
BEGIN;
DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM public.menu_allergen_codes WHERE active;
 IF n <> 23 THEN RAISE EXCEPTION 'expected 23 vocabulary entries, got %',n; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='menu_categories' AND policyname='menu_categories_routed_read') THEN
  RAISE EXCEPTION 'missing category RLS';
 END IF;
 IF has_table_privilege('anon','public.menu_item_allergen_reviews','SELECT') THEN
  RAISE EXCEPTION 'anon can inspect private safety review';
 END IF;
 IF has_table_privilege('authenticated','public.menu_item_allergen_reviews','UPDATE') THEN
  RAISE EXCEPTION 'authenticated can forge review row';
 END IF;
 IF has_function_privilege('anon','public.verify_menu_item_allergens(uuid,bigint)','EXECUTE') THEN
  RAISE EXCEPTION 'anon can call review RPC';
 END IF;
 IF NOT has_function_privilege('anon','public.get_menu_allergen_status()','EXECUTE') THEN
  RAISE EXCEPTION 'guest read RPC inaccessible';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='menu_items_category_tenant_fk') THEN
  RAISE EXCEPTION 'missing composite tenant category FK';
 END IF;
END $$;
ROLLBACK;
-- Further native harness scenarios REQUIRED before PASS:
-- two tenants, ownership change, wrong-category FK, default-unverified new item,
-- description invalidation, allergen/context edit invalidation, stale version races,
-- absent code rejects verification, guest headers fail closed,
-- unauthorised user and Floor role negative tests, old orders unchanged.
