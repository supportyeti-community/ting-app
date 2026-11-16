-- FS-01A COMPENSATING REVERSION — REVIEW ONLY, NOT AN AUTOMATIC MIGRATION.
-- This file belongs under docs/ so Supabase CLI will NOT auto-apply it.
-- DANGER: DESTRUCTIVE if the schema has been used; this transaction refuses
-- to run unless all category, assessment, and reviewed safety content is empty.
--
-- Prerequisites (NOT performed here):
-- 1. Explicit founder approval and documented recovery/backup verification.
-- 2. Disable FS-01A/FS-01B guests/Admin/import features and pause menu writes.
-- 3. Prove no dependent deployments, triggers, views, functions or migrations.
-- 4. Review connected schema/ledger against the precise approved migration hash.
-- 5. Rehearse with representative restored data in disposable native Supabase.
--
-- Prefer a forward correction or feature rollback that PRESERVES DATA if any
-- business category/allergen information was entered. Never delete/repair
-- Supabase migration history to mimic a rollback. A reviewed NEW forward
-- migration is needed if this transaction is ever authorised for deployment.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.menu_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.menu_categories IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.menu_item_allergen_assessments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.menu_item_allergen_reviews IN ACCESS EXCLUSIVE MODE;

DO $reversion_guard$
BEGIN
 IF to_regclass('public.menu_categories') IS NULL
    OR to_regclass('public.menu_item_allergen_assessments') IS NULL
    OR to_regclass('public.menu_item_allergen_reviews') IS NULL
    OR to_regclass('public.menu_allergen_codes') IS NULL THEN
  RAISE EXCEPTION 'FS-01A schema does not match expected installed state';
 END IF;

 IF EXISTS (SELECT 1 FROM public.menu_categories)
    OR EXISTS (SELECT 1 FROM public.menu_items WHERE category_id IS NOT NULL) THEN
  RAISE EXCEPTION 'STOP: category data exists; preserve and use a forward correction';
 END IF;

 IF EXISTS (SELECT 1 FROM public.menu_item_allergen_assessments) THEN
  RAISE EXCEPTION 'STOP: allergen assessments exist; preserve and use a forward correction';
 END IF;

 IF EXISTS (
   SELECT 1 FROM public.menu_item_allergen_reviews
   WHERE safety_version <> 1
      OR verified_version IS NOT NULL
      OR verified_by IS NOT NULL
      OR verified_at IS NOT NULL
      OR recipe_context IS NOT NULL
      OR preparation_context IS NOT NULL
 ) THEN
  RAISE EXCEPTION 'STOP: safety context or review history exists; preserve and use a forward correction';
 END IF;

 IF EXISTS (
  SELECT 1 FROM public.menu_items i
  LEFT JOIN public.menu_item_allergen_reviews r
    ON r.tenant_id=i.tenant_id AND r.menu_item_id=i.id
  WHERE r.menu_item_id IS NULL
 ) THEN
  RAISE EXCEPTION 'STOP: incomplete safety rows; investigate drift before any reversion';
 END IF;
END
$reversion_guard$;

-- Dependencies must not exist outside the isolated FS-01A contract.
-- These DROP statements use RESTRICT (default), NEVER CASCADE.
DROP FUNCTION public.get_menu_allergen_status();
DROP FUNCTION public.verify_menu_item_allergens(uuid,bigint);
DROP FUNCTION public.set_menu_item_safety_context(uuid,text,text,bigint);
DROP FUNCTION public.set_menu_item_allergen(uuid,text,text,text,bigint);

DROP TRIGGER menu_item_allergen_assessment_invalidation
  ON public.menu_item_allergen_assessments;
DROP FUNCTION ting_private.invalidate_allergen_review();

DROP TRIGGER menu_items_safety_description ON public.menu_items;
DROP TRIGGER menu_items_safety_creation ON public.menu_items;
DROP FUNCTION ting_private.track_menu_item_safety();

DROP TABLE public.menu_item_allergen_assessments;
DROP TABLE public.menu_item_allergen_reviews;
DROP TABLE public.menu_allergen_codes;

ALTER TABLE public.menu_items DROP CONSTRAINT menu_items_category_tenant_fk;
ALTER TABLE public.menu_items DROP COLUMN category_id;
DROP INDEX public.menu_items_tenant_id_id_unique;

DROP TRIGGER menu_categories_immutable ON public.menu_categories;
DROP FUNCTION ting_private.prevent_category_tenant_change();
DROP TABLE public.menu_categories;

-- Existing historical menu/order tables, their rows and existing RPCs remain.
-- FS-01A application code MUST already have been rolled back.
NOTIFY pgrst, 'reload schema';
COMMIT;
