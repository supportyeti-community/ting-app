-- TING-9 enforcement stage. Deploy only after the upgraded frontend and compatibility checks pass.
begin;

do $block$
begin
  if exists (select 1 from public.service_tickets where tenant_id is null) then
    raise exception 'TING-9 enforcement stopped: null-owned service tickets require a separately reviewed reconciliation before NOT NULL can be applied'
      using errcode = '23502';
  end if;
end;
$block$;

alter table public.service_tickets
  alter column tenant_id set not null;

alter policy "Public can create pending service tickets"
  on public.service_tickets
  with check (
    status = 'pending'
    and table_number ~ '^[A-Za-z0-9 _-]{1,20}$'
    and request_type is not null
    and length(trim(request_type)) between 1 and 500
    and client_slug is not null
    and tenant_id is not null
  );

commit;
