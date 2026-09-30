import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../../migrations/20260930030209_ting6_harden_sanitize_text_search_path.sql', import.meta.url),
  'utf8'
);
const baseline = readFileSync(
  new URL('../../baseline/schema.sql', import.meta.url),
  'utf8'
);

assert(
  baseline.includes('CREATE OR REPLACE FUNCTION public.sanitize_text()'),
  'recovery baseline must define public.sanitize_text() before the forward migration'
);

assert(
  /ALTER\s+FUNCTION\s+public\.sanitize_text\(\)\s+SET\s+search_path\s*=\s*''\s*;/i.test(migration),
  'TING-6 migration must pin sanitize_text() to an empty search_path'
);

assert(
  !/SECURITY\s+DEFINER/i.test(migration),
  'TING-6 must not change sanitize_text() into SECURITY DEFINER'
);

assert(
  !/CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(migration),
  'TING-6 must not rewrite the trigger body; behavior must remain unchanged'
);

for (const trigger of [
  'clean_menu_items_trigger',
  'clean_restaurant_settings_trigger',
  'clean_service_tickets_trigger',
]) {
  assert(
    baseline.includes(trigger),
    `recovery baseline must retain ${trigger}`
  );
}

console.log('PASS: TING-6 pins sanitize_text search_path without rewriting trigger behavior');
