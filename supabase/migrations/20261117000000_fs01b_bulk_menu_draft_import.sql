-- FS-01B. Stacked on FS-01A; disposable testing only until combined-release approval.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.menu_items ADD COLUMN import_draft boolean NOT NULL DEFAULT false;
ALTER TABLE public.menu_items ADD COLUMN import_requested_available boolean NOT NULL DEFAULT true;

CREATE TABLE public.menu_import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id),
 request_id uuid NOT NULL,
 payload_sha256 text NOT NULL CHECK (length(payload_sha256)=64),
 imported_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 result jsonb NOT NULL,
 UNIQUE (tenant_id,request_id)
);
ALTER TABLE public.menu_import_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.menu_import_batches FROM PUBLIC,anon,authenticated;
-- Results are exposed only through the authenticated RPC, never direct table access.

CREATE OR REPLACE FUNCTION public.import_menu_draft(p_request_id uuid,p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
 v_tenant uuid;
 v_user uuid := (select auth.uid());
 v_slug text;
 v_hash text;
 v_prior public.menu_import_batches%ROWTYPE;
 v_count integer;
 v_result jsonb;
BEGIN
 v_tenant := (select ting_private.request_tenant_id());
 IF v_tenant IS NULL OR v_user IS NULL OR p_request_id IS NULL THEN
  RAISE EXCEPTION 'authenticated routed owner/admin required' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM public.tenant_memberships m
  WHERE m.tenant_id=v_tenant AND m.user_id=v_user AND m.role IN ('owner','admin')
 ) THEN
  RAISE EXCEPTION 'owner/admin membership required' USING ERRCODE='42501';
 END IF;
 SELECT t.client_slug INTO v_slug FROM public.tenants t WHERE t.id=v_tenant;
 IF v_slug IS NULL THEN RAISE EXCEPTION 'tenant route missing' USING ERRCODE='42501'; END IF;
 IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' THEN
  RAISE EXCEPTION 'rows must be an array' USING ERRCODE='22023';
 END IF;
 v_count := jsonb_array_length(p_rows);
 IF v_count<1 OR v_count>500 OR octet_length(p_rows::text)>524288 THEN
  RAISE EXCEPTION 'menu import exceeds limits' USING ERRCODE='22023';
 END IF;
 v_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(p_rows::text,'UTF8')),'hex');
 -- Serialise identical keys in a tenant; lock is held until this transaction finishes.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tenant::text||':'||p_request_id::text,0));
 SELECT * INTO v_prior FROM public.menu_import_batches
 WHERE tenant_id=v_tenant AND request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.payload_sha256<>v_hash THEN
   RAISE EXCEPTION 'import key reused with different payload' USING ERRCODE='23505';
  END IF;
  RETURN v_prior.result;
 END IF;
 -- Every row is independently checked in the database, BEFORE inserts.
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(p_rows) r
  WHERE jsonb_typeof(r)<>'object'
     OR (r-'category'-'name'-'description'-'price'-'available'-'image_url')<>'{}'::jsonb
     OR jsonb_typeof(r->'name')<>'string'
     OR length(btrim(r->>'name')) NOT BETWEEN 1 AND 160
     OR jsonb_typeof(r->'category') IS DISTINCT FROM 'string'
     OR length(btrim(r->>'category')) NOT BETWEEN 1 AND 100
     OR jsonb_typeof(r->'price') NOT IN ('string','number')
     OR (r->>'price') !~ '^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$'
     OR jsonb_typeof(COALESCE(r->'available','true'::jsonb))<>'boolean'
     OR (r ? 'description' AND jsonb_typeof(r->'description') NOT IN ('string','null'))
     OR length(COALESCE(r->>'description',''))>2000
     OR (r ? 'image_url' AND jsonb_typeof(r->'image_url') NOT IN ('string','null'))
     OR length(COALESCE(r->>'image_url',''))>1000
     OR (COALESCE(r->>'image_url','')<>'' AND (r->>'image_url') !~ '^https://[^[:space:]]+$')
 ) THEN
  RAISE EXCEPTION 'invalid import row' USING ERRCODE='22023';
 END IF;
 IF EXISTS (
  SELECT 1 FROM (
   SELECT lower(btrim(r->>'category')) c, lower(btrim(r->>'name')) n, count(*) qty
   FROM jsonb_array_elements(p_rows) r
   GROUP BY 1,2 HAVING count(*)>1
  ) dup
 ) THEN RAISE EXCEPTION 'duplicate dish within import' USING ERRCODE='23505'; END IF;
 -- Reject existing dish duplicates, do not update or reconcile historical menu.
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(p_rows) r
  JOIN public.menu_items i ON i.tenant_id=v_tenant
   AND lower(btrim(i.name))=lower(btrim(r->>'name'))
  LEFT JOIN public.menu_categories c ON c.tenant_id=v_tenant AND c.id=i.category_id
  WHERE lower(btrim(COALESCE(c.name,'')))=lower(btrim(r->>'category'))
 ) THEN RAISE EXCEPTION 'dish already exists in category' USING ERRCODE='23505'; END IF;

 -- Category insert is set-based and tenant-constrained. The unique index handles racing requests.
 INSERT INTO public.menu_categories(tenant_id,name,sort_order)
 SELECT v_tenant,min(btrim(r->>'category')),row_number() over (order by lower(btrim(r->>'category')))::int
 FROM jsonb_array_elements(p_rows) r
 GROUP BY lower(btrim(r->>'category'))
 ON CONFLICT DO NOTHING;

 -- One statement inserts the entire batch, preserving source ordering and returning stable UUIDs.
 WITH parsed AS (
  SELECT ord::int n, r, gen_random_uuid() id
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS x(r,ord)
 ), created AS (
  INSERT INTO public.menu_items(id,tenant_id,client_slug,category_id,name,description,price,image_url,
                               is_out_of_stock,is_promo,sort_order,import_draft,import_requested_available)
  SELECT p.id,v_tenant,v_slug,c.id,btrim(p.r->>'name'),
         NULLIF(btrim(COALESCE(p.r->>'description','')),''),
         (p.r->>'price')::numeric,
         NULLIF(p.r->>'image_url',''),
         true,false,p.n,true,COALESCE((p.r->>'available')::boolean,true)
  FROM parsed p JOIN public.menu_categories c
    ON c.tenant_id=v_tenant AND lower(btrim(c.name))=lower(btrim(p.r->>'category'))
  RETURNING id
 )
 SELECT jsonb_build_object('request_id',p_request_id,'saved',count(*),
   'draft',true,'items',COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'row',p.n,
      'requested_available',COALESCE((p.r->>'available')::boolean,true)) ORDER BY p.n),'[]'::jsonb))
 INTO v_result
 FROM parsed p JOIN created cr ON cr.id=p.id;
 -- The parsed CTE must materialise consistently for the insert and result.
 IF (v_result->>'saved')::integer<>v_count THEN
  RAISE EXCEPTION 'import count mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.menu_import_batches(tenant_id,request_id,payload_sha256,imported_by,result)
 VALUES(v_tenant,p_request_id,v_hash,v_user,v_result);
 RETURN v_result;
END
$fn$;
REVOKE ALL ON FUNCTION public.import_menu_draft(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_menu_draft(uuid,jsonb) TO authenticated;
COMMENT ON FUNCTION public.import_menu_draft(uuid,jsonb) IS
 'Atomic tenant-routed owner/admin CSV/XLSX batch import; out-of-stock draft and unverified FS-01A reviews. No reconcile or allergen auto-verification.';
COMMIT;
