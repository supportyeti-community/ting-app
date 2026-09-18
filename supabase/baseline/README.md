# TinG database baseline — 17 September 2026

This is a catalogue-derived snapshot of the existing application database, not a
security fix or a migration to run against production. Known broad permissions
are preserved intentionally. No customer data, Auth users, keys, or uploaded
objects are included.

## Provenance

- Supabase: SupportYeti TMS (`okrwklulwrfnrhnffbwp`), PostgreSQL 17.6.
- Catalogue capture time: see `catalog.json` (`captured_at`), from one SELECT.
- Source frontend commit: `79b4eb65360d1edf5ae88bed48eddd02689cb537`.
- Production Vercel deployment: `dpl_7pFer9Evdk1sHLv4GFkaBsf74n4D`, READY,
  same commit. Customer and admin HTML matched GitHub in this session.
- No production schema, application rows, migration history, or runtime code
  were changed during capture and verification.

## Files

| File | Purpose |
|---|---|
| `capture.sql` | Read-only query to recapture supported application objects |
| `catalog.json` | Source catalogue, including object ACLs and platform observations |
| `generate.py` | Deterministic SQL renderer; no database connection |
| `schema.sql` | Generated, guarded application bootstrap for an empty target |
| `migration-history.json` | Actual migration names/versions and SQL-body MD5 fingerprints |
| `platform-observations.json` | Selected database settings and managed Storage ACL observations |
| `verify-replay.mjs` | Isolated PostgreSQL replay and catalogue comparison |
| `verification.json` | Recorded replay result and verification boundary |
| `package.json` / `package-lock.json` | Pinned verification-only dependency |

## Reproduce the application-schema verification

From the repository root, with Python 3 and Node.js/npm available:

```sh
python3 supabase/baseline/generate.py
npm ci --prefix supabase/baseline
npm test --prefix supabase/baseline
```

The test starts an in-memory PGlite PostgreSQL engine. It constructs minimal
`auth.users`, `auth.uid()`, Storage tables and role fixtures, applies the exact
generated SQL, and compares eleven catalogue sections plus postgres default
ACLs against the live capture. No production connection is used. It also checks
that execution without explicit target acknowledgement fails, and that replay
onto an already populated application schema fails. Comparison sorts arrays
because catalogue ordering is not significant. Column order is encoded by the
renderer using the source array; object content is otherwise compared exactly.

The recorded test used PostgreSQL 17.5 (PGlite 0.3.14); production is 17.6.
This is meaningful schema replay evidence, **not** a full Supabase stack test.

## Empty Supabase-compatible target bootstrap

Only use a disposable target with managed Auth/Storage schemas already present,
the `anon`, `authenticated`, `service_role`, `postgres`, and
`pg_database_owner` roles, and sufficient owner/superuser-equivalent privileges.
Inspect existing platform event triggers first: a conflicting `ensure_rls`
trigger must be reconciled in a separately reviewed target-specific bootstrap.
The snapshot deliberately fails rather than replacing an existing trigger.

The script requires the session setting
`ting.baseline_replay=approved-empty-target`. This acknowledgement is not an
authorization to run it on production. It checks for existing application
relations, runs transactionally, and uses CREATE rather than destructive DROP.
Do not disable the guards to force a restore onto an existing project.

## Capture coverage and deliberate boundaries

Captured: nine tables, 32 constraints, 23 indexes (including constraint indexes),
five functions, six row triggers, 28 public/Storage policies, schema/table/function
ACLs, default ACLs, RLS/replica identity flags, the application event trigger,
four Realtime publication tables and one bucket's non-secret configuration.
The catalogue confirmed no additional views, sequences, partitions, or custom
enum/domain/range types in the application schemas at capture time.

The renderer recreates postgres default ACLs. Platform-owned `supabase_admin`
defaults, installed extensions and managed `storage.objects` permissions are
observed but not overwritten. Auth/Storage platform definitions are supplied by
Supabase, not reverse-engineered here. Realtime publication configuration is
replayed; the Realtime service and websocket delivery are not exercised.

Not included or not verified:

- Production application rows, tenant routing keys, account memberships, Auth
  users, passwords, secrets, Storage object contents, or data recovery.
- Full Supabase Auth/API/Storage/Realtime services and extension installation.
- Dashboard-only configuration such as Auth redirects/providers, SMTP, JWT
  settings, exposed API schemas, backups/PITR, and environment secret values.
  Empty `pgrst` observations do not establish effective API configuration.
- A native PostgreSQL 17.6/full Supabase reset and deployment rehearsal.
- Historic SQL replay: migration fingerprints establish provenance, but earlier
  migrations may depend on pre-existing objects and are not a fresh bootstrap.

## Migration adoption

This snapshot stays outside `supabase/migrations` intentionally. The remote
database already has nine migration records; inserting a replacement baseline
into that history or replaying it on production would be incorrect. The next
TING-5 milestone is a native Supabase restore rehearsal, then an explicitly
reviewed history/baseline adoption strategy and CLI-generated forward migration
files. No history repair, squash, `db push`, or production application is part
of this change. TING-5 remains In progress.

## Known state carried forward

- `is_admin()` uses the global allowlist; it does not enforce tenant membership.
- Service-ticket ownership has a canonical resolver, NOT NULL tenant ID and
  immutable ownership. This snapshot does not rerun TING-9's production probes.
- Four other operational ownership columns remain nullable. Settings/table-link
  queries are not tenant-scoped; the table-link PK omits tenant ID.
- The TING-2 ownership baseline and `request_tenant_id()` are absent.
- Storage public SELECT is bucket-wide. `sanitize_text` lacks a fixed search
  path. These are recorded existing gaps, not remediated by this baseline.
- The frontend is two static HTML/JS files. Supabase JS is loaded from a floating
  `@2` CDN URL; QRCode.js is loaded at 1.0.0. No build step or Edge Function exists.

Do not treat successful baseline replay as proof of tenant isolation. Step 2
must implement and test that boundary independently.
