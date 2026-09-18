# TING-5 baseline and migration-history adoption

## Chosen arrangement

Preserve the nine original production migrations, byte-for-byte, in
`supabase/migrations`. Keep the current-state schema snapshot outside that
folder. Production already has the matching history: adoption requires no
production SQL, squash, replacement baseline record or history repair.

The recovered files were checked against the live ledger and the previously
captured manifest on 18 September 2026. Fingerprints use
`md5(array_to_string(statements, chr(10)))`, not `md5(statements::text)`.
Every historical row currently contains one statement string, so each file
preserves that exact UTF-8 string without an added separator or newline.
Historical comments saying "not executed" describe their authoring state;
the captured database ledger establishes that these versions were applied.

## Fresh environments

The legacy chain assumes predecessor tables and stage-specific demo data.
It is not an empty-database bootstrap. Do not run the nine historical files
against the current snapshot or use a vanilla `db reset` as the TinG bootstrap.

The native harness starts a fresh managed Supabase stack, restores the current
snapshot and verifies its catalogue. Only then, on that disposable loopback
instance with an empty migration ledger, it restores the nine exact historical
ledger entries and writes their matching files into the temporary CLI project.
It does not replay historical seed/backfill SQL or copy production rows.
This establishes the migration tracking state associated with the restored
schema, rather than claiming that historical migrations were re-executed.

Reproduce from the repository root with Node 24 and local Docker:

```sh
npm ci --prefix supabase/baseline/native
npm test --prefix supabase/baseline/native
```

## Forward deployment rehearsal

The harness uses the pinned Supabase CLI to test baseline-only dry-run/no-op
push, missing-version rejection, CLI-generated forward DDL, dry-run behavior,
apply-once behavior, and transaction rollback of a deliberately failing
migration. Correcting that still-pending migration must then succeed. Probe
files live only in the temporary project. They are not release migrations.
Original history must remain unchanged and the full application catalogue must
match again after probe cleanup. Real Auth/API/Storage/Realtime tests then run.
Consult the PR's workflow result; the existence of this harness is not a pass.

## Operating rule after review and merge

1. Keep historical files immutable. Generate future filenames with the pinned
   CLI's `migration new`; review the complete SQL and its transaction boundaries.
2. Rehearse each new change from this restored baseline, then from the latest
   deployed state. Extend expected-schema and service assertions for that issue;
   the baseline-only rehearsal is not automatic coverage of future SQL.
3. Before production deployment, compare the live history versions, names and
   statement fingerprints to the approved files, and recapture the schema to
   identify out-of-band drift. Stop on any unexpected difference.
4. Review `db push --dry-run --skip-vault` using the intended, authenticated
   deployment target. It must list only that release's approved new versions.
5. After release approval, a single deployment owner runs the forward push with
   vault/seed/role changes excluded, verifies the resulting ledger and affected
   services, and records the result. Never use `--include-all` or history repair
   to bypass an unexplained mismatch.

This PR includes no production credentials, deployment automation, production
history write, new release migration or merge. A future release needs its own
rollback/recovery plan; rollback of the deliberately failing local probe does
not establish reversibility of arbitrary migrations or data recovery.

## Review boundary

This arrangement follows TinG ADR-002 and ADR-005. The original migration SQL
contains historical internal-demo assumptions, but no copied Auth identities,
passwords, API keys or customer rows. The restored test accounts are synthetic.
PR #2 remains the review gate. Once the deployment rehearsal passes, baseline
and migration tooling are ready for review; production deployment remains a
separate release action. Tenant-isolation fixes belong to subsequent issues.
