begin;

alter policy "Public can create pending service tickets"
  on public.service_tickets
  with check (
    status = 'pending'
    and table_number ~ '^[A-Za-z0-9 _-]{1,20}$'
    and request_type is not null
    and length(trim(request_type)) between 1 and 500
  );

alter table public.service_tickets
  alter column tenant_id drop not null;

commit;