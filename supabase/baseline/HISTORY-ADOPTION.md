# TING-5 baseline and migration-history adoption

Status: proposal for review in PR #2. No production history changes have been
made. This is part of the baseline issue, not a tenant-security implementation.

## What is established

The captured production history has nine records, ending at
`20260805042037`. `migration-history.json` records their names and SQL-body
fingerprints. Those fingerprints are provenance, not executable migrations.
The current application schema also contains objects that predate this history.
Replaying the nine records alone is therefore not an established bootstrap.

## Proposed adoption

Keep the captured baseline immutable and outside `supabase/migrations`. Use it
only to bootstrap new disposable environments and compare their application
catalogues. Preserve the existing production migration ledger exactly.

Before enabling automatic forward deployment, recover the original historical
SQL into a reviewed archive, check each record against its captured fingerprint,
and inspect seed/backfill statements for embedded production data. Do not publish
customer data or credentials in this public repository. Do not replace historical
SQL with empty files merely to satisfy the CLI's version comparison.

Then choose and rehearse one explicit deployment-history arrangement: retain
the complete original chain plus its missing predecessor schema, or establish
a documented baseline cutover with separate bootstrap and forward histories.
The latter may need history alignment; any production ledger write is a separate
reviewable operation, with before/after evidence and recovery instructions.
This PR performs neither a squash nor history repair.

Future schema changes should be CLI-generated forward migrations, isolated by
issue. Test each against a freshly restored baseline and against the previously
deployed schema, including the relevant service behavior and failure path.
Require a reviewed deployment plan and checked history before enabling `db push`.

## Completion boundary

A successful native service rehearsal establishes that the captured application
schema can operate on the reported local Supabase stack. It does not establish
production data recovery, matching dashboard configuration, historical replay,
or safe production deployment. TING-5 remains open until its repeatable deployment
acceptance criterion and history arrangement are actually rehearsed.

This follows the existing Supabase platform decision and the one-issue review
workflow in TinG's ADR-002 and ADR-005. The current PR remains unmerged.
