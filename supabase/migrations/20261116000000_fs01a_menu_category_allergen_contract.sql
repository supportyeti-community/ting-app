-- FS-01A — PROPOSED / NOT EXECUTED
-- Run only in an isolated disposable native environment before founder-approved connected rollout.
-- Expand-only: historical menus and order snapshots are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Venue categories. Item IDs and historical orders are unchanged.
CREATE TABLE public.menu_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
 sort_order integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id)
);
CREATE UNIQUE INDEX menu_categories_tenant_name_key
 ON public.menu_categories (tenant_id,lower(btrim(name)));
CREATE INDEX menu_categories_tenant_sort_idx
 ON public.menu_categories (tenant_id,sort_order,id);
ALTER TABLE public.menu_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_categories FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.menu_categories TO anon, authenticated;
GRANT INSERT,UPDATE,DELETE ON public.menu_categories TO authenticated;
CREATE POLICY menu_categories_routed_read ON public.menu_categories FOR SELECT TO anon,authenticated
 USING (tenant_id = (SELECT ting_private.request_tenant_id()));
CREATE POLICY menu_categories_member_read ON public.menu_categories FOR SELECT TO authenticated
 USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_categories_member_insert ON public.menu_categories FOR INSERT TO authenticated
 WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_categories_member_update ON public.menu_categories FOR UPDATE TO authenticated
 USING (ting_private.can_manage_tenant(tenant_id))
 WITH CHECK (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_categories_member_delete ON public.menu_categories FOR DELETE TO authenticated
 USING (ting_private.can_manage_tenant(tenant_id));

CREATE OR REPLACE FUNCTION ting_private.prevent_category_tenant_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'category ownership immutable' USING ERRCODE='23514';
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION ting_private.prevent_category_tenant_change() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER menu_categories_immutable BEFORE UPDATE ON public.menu_categories
 FOR EACH ROW EXECUTE FUNCTION ting_private.prevent_category_tenant_change();

-- Composite item FK; legacy items retain NULL category and must be rendered as Uncategorised.
CREATE UNIQUE INDEX IF NOT EXISTS menu_items_tenant_id_id_unique
 ON public.menu_items (tenant_id,id);
ALTER TABLE public.menu_items ADD COLUMN category_id uuid NULL;
ALTER TABLE public.menu_items ADD CONSTRAINT menu_items_category_tenant_fk
 FOREIGN KEY (tenant_id,category_id) REFERENCES public.menu_categories(tenant_id,id)
 ON UPDATE RESTRICT ON DELETE RESTRICT;
CREATE INDEX menu_items_tenant_category_sort_idx
 ON public.menu_items(tenant_id,category_id,sort_order,id);

-- 2. Controlled Australian vocabulary. The public vocabulary has no venue data.
CREATE TABLE public.menu_allergen_codes (
 code text PRIMARY KEY,
 label text NOT NULL,
 active boolean NOT NULL DEFAULT true
);
INSERT INTO public.menu_allergen_codes(code,label) VALUES
 ('wheat','Wheat'),('barley','Barley (gluten-containing)'),('oats','Oats (gluten-containing)'),
 ('rye','Rye (gluten-containing)'),('fish','Fish'),('crustacean','Crustacean'),
 ('mollusc','Mollusc'),('egg','Egg'),('milk','Milk'),('lupin','Lupin'),
 ('peanut','Peanut'),('soy','Soy'),('sesame','Sesame'),
 ('almond','Almond'),('brazil_nut','Brazil nut'),('cashew','Cashew'),
 ('hazelnut','Hazelnut'),('macadamia','Macadamia'),('pecan','Pecan'),
 ('pine_nut','Pine nut'),('pistachio','Pistachio'),('walnut','Walnut'),
 ('sulphites','Sulphites');
ALTER TABLE public.menu_allergen_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_allergen_codes FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.menu_allergen_codes TO anon,authenticated;
CREATE POLICY menu_allergen_codes_read ON public.menu_allergen_codes FOR SELECT TO anon,authenticated USING (true);

CREATE TABLE public.menu_item_allergen_reviews (
 tenant_id uuid NOT NULL,
 menu_item_id uuid NOT NULL,
 safety_version bigint NOT NULL DEFAULT 1 CHECK(safety_version>0),
 verified_version bigint NULL,
 verified_by uuid NULL, -- retain historical reviewer identity even if Auth user is retired
 verified_at timestamptz NULL,
 recipe_context text NULL,
 preparation_context text NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,menu_item_id),
 FOREIGN KEY(tenant_id,menu_item_id) REFERENCES public.menu_items(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT verified_review_consistency CHECK (
  (verified_version IS NULL AND verified_by IS NULL AND verified_at IS NULL)
  OR (verified_version = safety_version AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
 )
);
CREATE TABLE public.menu_item_allergen_assessments (
 tenant_id uuid NOT NULL,
 menu_item_id uuid NOT NULL,
 allergen_code text NOT NULL REFERENCES public.menu_allergen_codes(code),
 state text NOT NULL CHECK(state IN ('contains','may_contain','assessed_absent','unknown')),
 evidence_note text NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,menu_item_id,allergen_code),
 FOREIGN KEY(tenant_id,menu_item_id) REFERENCES public.menu_items(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX menu_item_allergen_assessments_item_idx ON public.menu_item_allergen_assessments(tenant_id,menu_item_id);
ALTER TABLE public.menu_item_allergen_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_item_allergen_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_item_allergen_reviews FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.menu_item_allergen_assessments FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.menu_item_allergen_reviews,public.menu_item_allergen_assessments TO authenticated;
CREATE POLICY menu_allergen_reviews_manager_read ON public.menu_item_allergen_reviews FOR SELECT TO authenticated
 USING (ting_private.can_manage_tenant(tenant_id));
CREATE POLICY menu_allergen_assessments_manager_read ON public.menu_item_allergen_assessments FOR SELECT TO authenticated
 USING (ting_private.can_manage_tenant(tenant_id));

-- Review rows are system-owned. Triggers make item creation/description changes fail atomically
-- if their review state cannot be recorded. No client direct safety-field writes.
CREATE OR REPLACE FUNCTION ting_private.track_menu_item_safety() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
 IF TG_OP = 'INSERT' THEN
  INSERT INTO public.menu_item_allergen_reviews(tenant_id,menu_item_id)
  VALUES(NEW.tenant_id,NEW.id);
 ELSIF NEW.description IS DISTINCT FROM OLD.description THEN
  UPDATE public.menu_item_allergen_reviews
   SET safety_version=safety_version+1,verified_version=NULL,
       verified_by=NULL,verified_at=NULL,updated_at=now()
   WHERE tenant_id=NEW.tenant_id AND menu_item_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing menu safety review' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION ting_private.track_menu_item_safety() FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.menu_item_allergen_reviews(tenant_id,menu_item_id)
 SELECT tenant_id,id FROM public.menu_items;
CREATE TRIGGER menu_items_safety_creation AFTER INSERT ON public.menu_items
 FOR EACH ROW EXECUTE FUNCTION ting_private.track_menu_item_safety();
CREATE TRIGGER menu_items_safety_description AFTER UPDATE OF description ON public.menu_items
 FOR EACH ROW EXECUTE FUNCTION ting_private.track_menu_item_safety();

-- Every assessment write invalidates the previous review, including privileged maintenance writes.
-- Lock ordering is item row then review row in the RPC; privileged maintenance must
-- use the same lock order when changing multiple items.
CREATE OR REPLACE FUNCTION ting_private.invalidate_allergen_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_tenant uuid; v_item uuid;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.menu_item_id IS DISTINCT FROM OLD.menu_item_id OR NEW.allergen_code IS DISTINCT FROM OLD.allergen_code) THEN
  RAISE EXCEPTION 'allergen assessment identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' THEN
  v_tenant:=OLD.tenant_id;v_item:=OLD.menu_item_id;
 ELSE
  v_tenant:=NEW.tenant_id;v_item:=NEW.menu_item_id;
 END IF;
 UPDATE public.menu_item_allergen_reviews
  SET safety_version=safety_version+1,verified_version=NULL,
      verified_by=NULL,verified_at=NULL,updated_at=now()
 WHERE tenant_id=v_tenant AND menu_item_id=v_item;
 IF NOT FOUND AND EXISTS (SELECT 1 FROM public.menu_items i WHERE i.tenant_id=v_tenant AND i.id=v_item) THEN
  RAISE EXCEPTION 'missing safety review for allergen assessment' USING ERRCODE='23514';
 END IF;
 RETURN NULL; -- AFTER row trigger; return is ignored.
END $f$;
REVOKE ALL ON FUNCTION ting_private.invalidate_allergen_review() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER menu_item_allergen_assessment_invalidation
 AFTER INSERT OR UPDATE OR DELETE ON public.menu_item_allergen_assessments
 FOR EACH ROW EXECUTE FUNCTION ting_private.invalidate_allergen_review();

-- Guarded writes always derive the caller, tenant and version server-side.
CREATE FUNCTION public.set_menu_item_allergen(
 p_item_id uuid,p_code text,p_state text,p_evidence_note text,p_expected_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_tenant uuid; v_version bigint;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'login required' USING ERRCODE='42501'; END IF;
 SELECT tenant_id INTO v_tenant FROM public.menu_items WHERE id=p_item_id FOR UPDATE;
 IF v_tenant IS NULL OR NOT ting_private.can_manage_tenant(v_tenant) THEN
  RAISE EXCEPTION 'not authorised' USING ERRCODE='42501'; END IF;
 IF p_state NOT IN ('contains','may_contain','assessed_absent','unknown')
    OR p_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.menu_allergen_codes WHERE code=p_code AND active) THEN
  RAISE EXCEPTION 'invalid assessment' USING ERRCODE='22023'; END IF;
 SELECT safety_version INTO v_version FROM public.menu_item_allergen_reviews
  WHERE tenant_id=v_tenant AND menu_item_id=p_item_id FOR UPDATE;
 IF v_version IS DISTINCT FROM p_expected_version THEN
  RAISE EXCEPTION 'stale safety version' USING ERRCODE='40001'; END IF;
 INSERT INTO public.menu_item_allergen_assessments(tenant_id,menu_item_id,allergen_code,state,evidence_note)
 VALUES (v_tenant,p_item_id,p_code,p_state,p_evidence_note)
 ON CONFLICT(tenant_id,menu_item_id,allergen_code) DO UPDATE
  SET state=excluded.state,evidence_note=excluded.evidence_note,updated_at=now();
 SELECT safety_version INTO v_version FROM public.menu_item_allergen_reviews
 WHERE tenant_id=v_tenant AND menu_item_id=p_item_id;
 RETURN v_version;
END $f$;

CREATE FUNCTION public.set_menu_item_safety_context(
 p_item_id uuid,p_recipe text,p_preparation text,p_expected_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_tenant uuid;v_version bigint;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'login required' USING ERRCODE='42501'; END IF;
 SELECT tenant_id INTO v_tenant FROM public.menu_items WHERE id=p_item_id FOR UPDATE;
 IF v_tenant IS NULL OR NOT ting_private.can_manage_tenant(v_tenant) THEN
  RAISE EXCEPTION 'not authorised' USING ERRCODE='42501'; END IF;
 SELECT safety_version INTO v_version FROM public.menu_item_allergen_reviews
  WHERE tenant_id=v_tenant AND menu_item_id=p_item_id FOR UPDATE;
 IF v_version IS DISTINCT FROM p_expected_version THEN
  RAISE EXCEPTION 'stale safety version' USING ERRCODE='40001'; END IF;
 UPDATE public.menu_item_allergen_reviews SET recipe_context=p_recipe,
  preparation_context=p_preparation,safety_version=safety_version+1,
  verified_version=NULL,verified_by=NULL,verified_at=NULL,updated_at=now()
 WHERE tenant_id=v_tenant AND menu_item_id=p_item_id RETURNING safety_version INTO v_version;
 RETURN v_version;
END $f$;

CREATE FUNCTION public.verify_menu_item_allergens(p_item_id uuid,p_expected_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$
DECLARE v_tenant uuid;v_version bigint;v_count integer;v_required integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'login required' USING ERRCODE='42501'; END IF;
 SELECT tenant_id INTO v_tenant FROM public.menu_items WHERE id=p_item_id FOR UPDATE;
 IF v_tenant IS NULL OR NOT ting_private.can_manage_tenant(v_tenant) THEN
  RAISE EXCEPTION 'not authorised' USING ERRCODE='42501'; END IF;
 SELECT safety_version INTO v_version FROM public.menu_item_allergen_reviews
  WHERE tenant_id=v_tenant AND menu_item_id=p_item_id FOR UPDATE;
 IF v_version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'stale safety version' USING ERRCODE='40001'; END IF;
 SELECT count(*) INTO v_required FROM public.menu_allergen_codes WHERE active;
 SELECT count(*) INTO v_count FROM public.menu_item_allergen_assessments a
 JOIN public.menu_allergen_codes c ON c.code=a.allergen_code AND c.active
 WHERE a.tenant_id=v_tenant AND a.menu_item_id=p_item_id AND a.state <> 'unknown';
 IF v_count <> v_required THEN
  RAISE EXCEPTION 'each active allergen requires explicit assessment' USING ERRCODE='23514'; END IF;
 UPDATE public.menu_item_allergen_reviews
 SET verified_version=safety_version,verified_by=auth.uid(),verified_at=now(),updated_at=now()
 WHERE tenant_id=v_tenant AND menu_item_id=p_item_id;
 RETURN v_version;
END $f$;

-- Guest-facing projections never expose kitchen notes, staff identities or draft private data.
CREATE FUNCTION public.get_menu_allergen_status()
RETURNS TABLE(menu_item_id uuid,allergen_code text,state text,review_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
 SELECT i.id,c.code,
        COALESCE(a.state,'unknown') AS state,
        (r.verified_version IS NOT NULL AND r.verified_version=r.safety_version) AS review_current
 FROM public.menu_items i
 CROSS JOIN public.menu_allergen_codes c
 JOIN public.menu_item_allergen_reviews r ON r.tenant_id=i.tenant_id AND r.menu_item_id=i.id
 LEFT JOIN public.menu_item_allergen_assessments a
  ON a.tenant_id=i.tenant_id AND a.menu_item_id=i.id AND a.allergen_code=c.code
 WHERE i.tenant_id=(SELECT ting_private.request_tenant_id()) AND c.active;
$f$;
REVOKE ALL ON FUNCTION public.set_menu_item_allergen(uuid,text,text,text,bigint),
 public.set_menu_item_safety_context(uuid,text,text,bigint),
 public.verify_menu_item_allergens(uuid,bigint),
 public.get_menu_allergen_status() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.set_menu_item_allergen(uuid,text,text,text,bigint),
 public.set_menu_item_safety_context(uuid,text,text,bigint),
 public.verify_menu_item_allergens(uuid,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_menu_allergen_status() TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
