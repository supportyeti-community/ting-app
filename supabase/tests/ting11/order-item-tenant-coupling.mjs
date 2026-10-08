import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const migration = readFileSync(
  new URL('../../migrations/20261008075500_ting11_order_item_tenant_coupling.sql', import.meta.url),
  'utf8'
);

assert(
  migration.includes('ADD CONSTRAINT orders_tenant_id_id_key UNIQUE (tenant_id, id)'),
  'orders must expose a composite tenant/id key for child ownership coupling'
);
assert(
  migration.includes('DROP CONSTRAINT order_items_order_id_fkey'),
  'single-column parent order foreign key must be replaced'
);
assert(
  migration.includes('FOREIGN KEY (tenant_id, order_id)'),
  'order items must carry a composite parent foreign key'
);
assert(
  migration.includes('REFERENCES public.orders (tenant_id, id)'),
  'order items must reference the parent order through tenant_id and order_id together'
);
assert(
  migration.includes('ON DELETE CASCADE'),
  'order item lifecycle must remain coupled to the parent order'
);

console.log('PASS: TING-11A order items cannot drift across parent-order tenant ownership');
