import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../supabase/migrations/20261030084000_ops1_orders_realtime.sql', import.meta.url), 'utf8');

assert(migration.includes("pubname = 'supabase_realtime'"), 'OPS-1 migration must target the Supabase Realtime publication');
assert(migration.includes("schemaname = 'public'"), 'OPS-1 migration must target the public schema');
assert(migration.includes("tablename = 'orders'"), 'OPS-1 migration must provision orders only when missing');
assert(migration.includes('alter publication supabase_realtime add table public.orders'), 'OPS-1 migration must add public.orders to Realtime');
assert(!migration.includes('order_items'), 'OPS-1 must not widen Realtime publication to order_items');

console.log('PASS: OPS-1 migration idempotently provisions public.orders only for Supabase Realtime');
