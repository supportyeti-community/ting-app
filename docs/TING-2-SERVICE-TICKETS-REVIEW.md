# TING-2 service-ticket authorization review

## Scope

This bounded slice changes only the `service_tickets` authorization boundary and the dashboard paths that read, update, and subscribe to it.

## Current gap reproduced

- Public inserts choose ownership from the payload slug rather than the resolved request route.
- Staff read/update/delete policies use the legacy global `is_admin()` allowlist.
- `anon` and `authenticated` retain broad table grants.
- The dashboard subscribes to every Realtime mutation without a tenant filter.

## Proposed controls

- Route-bind every insert using `ting_private.request_tenant_id()` and canonicalize both ownership fields in the existing trigger.
- Backfill the four reviewed historical null slugs from their existing tenant ownership, then require both ownership fields.
- Replace global-admin policies with `ting_private.can_manage_tenant(tenant_id)` member read/status-update policies.
- Limit grants to anonymous insert and authenticated select/insert/update.
- Treat tickets as retained operational records: request details are immutable and client delete is disabled.
- Keep `service_tickets` in Realtime for immediate assistance, but subscribe only to tenant-filtered INSERT and UPDATE events. Polling remains the fallback.

## Why DELETE is excluded

Supabase Postgres Changes does not apply RLS filtering to DELETE events and cannot filter them by tenant. TinG does not use client deletion; resolution is a status update. Disabling client delete preserves the operational history and avoids creating routine cross-tenant delete notifications while the table remains published.

## Verification required

- Native PostgreSQL 17 / Supabase CLI restore, dry-run, single apply, repeated no-op, and prior-ledger preservation.
- SQL role simulation for routed insert, forged route/payload denial, tenant-member read/update, foreign-row denial, global-admin denial, immutable request details, revoked membership, grants, and publication membership.
- Real Auth/REST route insert and tenant-member status update.
- Static frontend verification for explicit tenant filters and INSERT/UPDATE-only Realtime subscriptions.

Production rollout is explicitly out of scope until separately approved.
