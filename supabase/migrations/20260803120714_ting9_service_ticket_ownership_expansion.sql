-- TING-9 expansion stage. Review and deploy only after an approved checkpoint.
begin;

alter table public.service_tickets
  add column client_slug text;

create function ting_private.assign_service_ticket_tenant()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  resolved_tenant_id uuid;
begin
  if tg_table_schema <> 'public'
     or tg_table_name <> 'service_tickets'
     or tg_when <> 'BEFORE'
     or tg_level <> 'ROW'
     or tg_op not in ('INSERT', 'UPDATE') then
    raise exception 'assign_service_ticket_tenant may only run as the approved public.service_tickets row trigger'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new.client_slug is distinct from old.client_slug
       or new.tenant_id is distinct from old.tenant_id then
      raise exception 'service ticket ownership cannot be changed after creation'
        using errcode = '23514';
    end if;
    return new;
  end if;

  -- Compatibility window: the deployed legacy customer page sends neither field.
  if new.client_slug is null then
    if new.tenant_id is not null then
      raise exception 'tenant_id requires client_slug for canonical verification'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select tenant.id
    into resolved_tenant_id
    from public.tenants as tenant
   where tenant.client_slug = new.client_slug;

  if resolved_tenant_id is null then
    raise exception 'unknown client_slug'
      using errcode = '23514';
  end if;

  if new.tenant_id is not null and new.tenant_id <> resolved_tenant_id then
    raise exception 'tenant_id does not match client_slug'
      using errcode = '23514';
  end if;

  new.tenant_id := resolved_tenant_id;
  return new;
end;
$function$;

alter function ting_private.assign_service_ticket_tenant() owner to postgres;
revoke all on function ting_private.assign_service_ticket_tenant() from public, anon, authenticated;

-- BEFORE triggers at the same timing execute alphabetically; this precedes clean_service_tickets_trigger.
create trigger a_assign_service_ticket_tenant
before insert or update on public.service_tickets
for each row execute function ting_private.assign_service_ticket_tenant();

commit;
