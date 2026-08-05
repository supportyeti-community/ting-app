-- TING-9 verification package. Do not run without separate approval.
-- Section A is read-only. Section B runs inside one transaction, restores its
-- starting row count, and always ends in ROLLBACK.

-- A. Read-only structural checks
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'service_tickets'
order by ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.service_tickets'::regclass
order by conname;

select polname,
       polcmd,
       polroles::regrole[],
       pg_get_expr(polqual, polrelid) as using_expression,
       pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy
where polrelid = 'public.service_tickets'::regclass
order by polname;

select tgname, tgenabled, pg_get_triggerdef(oid)
from pg_trigger
where tgrelid = 'public.service_tickets'::regclass
  and not tgisinternal
order by tgname;

select p.oid::regprocedure,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef,
       p.proconfig,
       has_function_privilege('anon', p.oid, 'execute') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'ting_private'
  and p.proname = 'assign_service_ticket_tenant';

select tenant_id is null as is_null_owned, count(*)
from public.service_tickets
group by tenant_id is null;

select pub.pubname, pg_get_expr(pr.prqual, pr.prrelid) as row_filter
from pg_publication_rel pr
join pg_publication pub on pub.oid = pr.prpubid
where pr.prrelid = 'public.service_tickets'::regclass;

-- B. Rollback-only behavioral assertions.
-- The known canonical internal-demo slug is deliberate; replace no values.
begin;

create temporary table ting9_verification_baseline
on commit drop
as
select count(*)::bigint as service_ticket_count
from public.service_tickets;

set local role anon;

-- The deployed writer generates this UUID before its retry loop and performs a
-- plain INSERT on every attempt. The first successful attempt creates one row.
insert into public.service_tickets (id, table_number, request_type, client_slug)
values (
  '11111111-1111-4111-8111-111111111111',
  'TING9-A',
  'verification valid slug',
  'the-bistro'
);

-- A repeated plain INSERT with the same stable UUID must fail only as the
-- expected primary-key duplicate. Any other SQLSTATE or constraint is re-raised.
do $block$
declare
  caught_sqlstate text;
  caught_constraint text;
begin
  begin
    insert into public.service_tickets (id, table_number, request_type, client_slug)
    values (
      '11111111-1111-4111-8111-111111111111',
      'TING9-A',
      'verification valid slug',
      'the-bistro'
    );

    raise exception 'expected stable-UUID duplicate insert to fail';
  exception
    when unique_violation then
      get stacked diagnostics
        caught_sqlstate = returned_sqlstate,
        caught_constraint = constraint_name;

      if caught_sqlstate <> '23505'
         or caught_constraint <> 'service_tickets_pkey' then
        raise;
      end if;
  end;
end;
$block$;

-- Enforcement must reject a writer that omits client_slug.
do $block$
begin
  begin
    insert into public.service_tickets (id, table_number, request_type)
    values (
      '22222222-2222-4222-8222-222222222222',
      'TING9-B',
      'missing ownership probe'
    );
    raise exception 'expected missing client_slug to be rejected';
  exception
    when insufficient_privilege then null;
  end;
end;
$block$;

-- The assignment trigger must reject an unknown slug.
do $block$
begin
  begin
    insert into public.service_tickets (id, table_number, request_type, client_slug)
    values (
      '33333333-3333-4333-8333-333333333333',
      'TING9-C',
      'unknown ownership probe',
      'does-not-exist'
    );
    raise exception 'expected unknown client_slug to be rejected';
  exception
    when check_violation then
      if sqlerrm <> 'unknown client_slug' then raise; end if;
  end;
end;
$block$;

-- Supplied tenant_id must not conflict with the slug's canonical tenant.
do $block$
begin
  begin
    insert into public.service_tickets (id, table_number, request_type, client_slug, tenant_id)
    values (
      '44444444-4444-4444-8444-444444444444',
      'TING9-D',
      'conflicting ownership probe',
      'the-bistro',
      '00000000-0000-0000-0000-000000000000'
    );
    raise exception 'expected conflicting tenant ownership to be rejected';
  exception
    when check_violation then
      if sqlerrm <> 'tenant_id does not match client_slug' then raise; end if;
  end;
end;
$block$;

-- Existing request validation and the strengthened INSERT policy must still
-- reject invalid request content.
do $block$
begin
  begin
    insert into public.service_tickets (id, table_number, request_type, client_slug)
    values (
      '55555555-5555-4555-8555-555555555555',
      '!!',
      '   ',
      'the-bistro'
    );
    raise exception 'expected invalid request content to be rejected';
  exception
    when insufficient_privilege then null;
    when check_violation then null;
  end;
end;
$block$;

reset role;

-- Confirm the successful writer path resolved canonical ownership and the
-- duplicate attempt did not create another row.
do $block$
declare
  matching_rows integer;
  stored_slug text;
  stored_tenant_id uuid;
  canonical_tenant_id uuid;
begin
  select count(*)
    into matching_rows
    from public.service_tickets
   where id = '11111111-1111-4111-8111-111111111111';

  if matching_rows <> 1 then
    raise exception 'valid insert produced % rows instead of one', matching_rows;
  end if;

  select client_slug, tenant_id
    into stored_slug, stored_tenant_id
    from public.service_tickets
   where id = '11111111-1111-4111-8111-111111111111';

  select id
    into canonical_tenant_id
    from public.tenants
   where client_slug = 'the-bistro';

  if stored_slug <> 'the-bistro'
     or stored_tenant_id is distinct from canonical_tenant_id then
    raise exception 'valid insert did not preserve one canonically owned ticket';
  end if;
end;
$block$;

-- Ownership is immutable after creation.
do $block$
begin
  begin
    update public.service_tickets
       set client_slug = 'does-not-exist'
     where id = '11111111-1111-4111-8111-111111111111';
    raise exception 'expected ownership mutation to be rejected';
  exception
    when check_violation then
      if sqlerrm <> 'service ticket ownership cannot be changed after creation' then raise; end if;
  end;
end;
$block$;

-- Privileged verification smoke test: the normal status field remains mutable.
-- Section A separately exposes the deployed admin RLS policies for review.
update public.service_tickets
   set status = 'resolved'
 where id = '11111111-1111-4111-8111-111111111111';

do $block$
begin
  if not exists (
    select 1
      from public.service_tickets
     where id = '11111111-1111-4111-8111-111111111111'
       and status = 'resolved'
  ) then
    raise exception 'normal status update did not succeed';
  end if;
end;
$block$;

-- Remove the one successful verification row inside this transaction, prove
-- the starting count is restored, then roll the entire transaction back.
delete from public.service_tickets
where id = '11111111-1111-4111-8111-111111111111';

do $block$
declare
  expected_count bigint;
  actual_count bigint;
begin
  select service_ticket_count
    into expected_count
    from ting9_verification_baseline;

  select count(*)::bigint
    into actual_count
    from public.service_tickets;

  if actual_count <> expected_count then
    raise exception 'verification row count changed: expected %, got %', expected_count, actual_count;
  end if;
end;
$block$;

rollback;
