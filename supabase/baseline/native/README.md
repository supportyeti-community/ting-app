# Native Supabase restore rehearsal

This harness creates a new temporary Supabase CLI project and runs the baseline
against real local PostgreSQL 17, Auth, PostgREST, Storage and Realtime services.
It needs Node.js 24 and a local Docker engine. It never links to a cloud project
or uses repository secrets. All accounts, rows and image contents are synthetic.

```sh
npm ci --prefix supabase/baseline/native
npm test --prefix supabase/baseline/native
```

The same command runs on a disposable Ubuntu GitHub Actions runner through
`.github/workflows/ting-baseline-restore.yml`. The workflow has read-only GitHub
permissions, pinned action commits, no deployment step, and a 20-minute timeout.
The new local project's containers/volumes are removed on normal completion or
failure. On runner cancellation, the disposable runner is destroyed by GitHub.
Do not run against a shared Docker daemon or forward its ports publicly.

Checks include exact application catalogue comparison, both bootstrap guards,
real password login, the existing global admin allowlist, REST menu writes and
sanitization, ticket ownership and resolution, websocket delivery from a REST
insert, and Storage upload/public download/delete with non-admin write denial.
These are service smoke tests, not a complete tenant-isolation or browser test.

The CLI supplies managed platform schemas. Conflicting pre-existing event
triggers or catalogue differences fail the rehearsal for explicit inspection;
the harness does not drop them or loosen comparison to get a pass. The exact
native PostgreSQL version and installed extensions are recorded when reached.
A PostgreSQL 17 patch-version difference is reported, not represented as 17.6.

CLI startup/status output is withheld because it contains ephemeral credentials.
Only the sanitized `result.json` is shown in logs and the Actions job summary.
This generated result is ignored by Git. A committed harness alone is not
evidence of a successful restore: consult the actual workflow run outcome.
