# TinG production database backup and restore gate

**Status: IMPLEMENTATION / CERTIFICATION PENDING.** This documentation is not proof of a successful production restore. Every backup must include `auth`, application schemas and `supabase_migrations.schema_migrations`, and must pass a fully disposable restore test before it may be called a certified recovery point.

## Scope and nonnegotiable controls

- Production Supabase project: `okrwklulwrfnrhnffbwp`. Current plan: Free; automatic managed backups and PITR are not included. This workflow targets **logical PostgreSQL backups**, not physical PITR.
- Scheduled nightly at `17 16 * * *` UTC, plus manually dispatched pre-release `workflow_dispatch`; all production connections must be read-only. No production `migration repair`, `db push`, DDL, test users, seed orders or restore commands.
- Pin Supabase CLI `2.117.0` and restore to a disposable PostgreSQL `17.6` Supabase environment in an ephemeral GitHub Actions runner. If database compatibility changes, fail closed.
- Capture role definitions, application schema and application data, Auth users and related records, and all existing migration-history records. **Do not** accept a standard `supabase db dump` if it omitted managed Auth data.
- Independently verify copied table row counts, exactly 29 migration versions at the 17 November 2026 baseline (later releases must update this expected-version contract deliberately), all five FS-01 tables have ENABLE RLS without FORCE RLS, and public policies exist. Never print raw SQL dump text, passwords, auth user records or JWT tokens in Actions logs.
- Package files in a compressed tarball. On this **public repository**, encrypt with GPG AES-256 *before* uploading. Store **only ciphertext** in Actions artifacts, retention `30` days. Never commit dumps, link backups in Vercel, or upload raw data as failure artifacts.
- Derive a key from high-entropy GitHub `SUPABASE_ACCESS_TOKEN` unless a separate `TING_BACKUP_PASSPHRASE` GitHub secret is configured. Key derivation is domain-separated for this database and artifact version. Strong preference: configure a dedicated passphrase when convenient. **If either token or dedicated passphrase is rotated, retain the original key securely until all artifacts encrypted under it have expired or been re-encrypted**. A token-based backup key deliberately couples recoverability to that token; rotating without retaining key makes historical artifacts undecryptable.
- Restrict upload only to successfully certified dump+restore; verify the uploaded encrypted artifact exists and is unexpired. A workflow run without its ciphertext artifact is NOT a completed backup.
- Storage API objects/files, Edge Functions, application deploy settings, Stripe configuration, MFA/provider settings, and secrets are **outside this database-only recovery scope**. A database logical dump cannot create a complete restoration of the Supabase project or recover deleted Storage objects.

## Recovery playbook

1. Select the latest SUCCESSful *backup + disposable restore* GitHub Actions run and download its **encrypted** artifact. Verify the run's report and GitHub retention/expiry. The repository is public; never share the decryption key.
2. In a trusted secure restoration environment, supply the exact passphrase (or the old high-entropy `SUPABASE_ACCESS_TOKEN` used to derive the same key), decrypt the GPG file, and verify the compressed archive checksums. Treat restored Auth records as sensitive personal information. Do not decrypt on an untrusted device.
3. First rehearse using the same disposable Supabase PostgreSQL major and patch level; verify migration ledger, rows and RLS, role privileges, and relevant Auth login. Only then approve any recovery actions against a newly provisioned project. Never restore into the live production database without a separate Founder emergency approval.
4. Provision the replacement project through an independently approved process; apply platform-managed schema carefully, restore roles/grants, application schema, Auth, historical data and migration history in compatible order, and separately reconfigure Auth, Storage objects, API keys, functions, secrets, custom domain and integration webhooks. Reissue credentials and validate tenant isolation before exposing traffic. No automatic production restore is implemented in this workflow.
5. For a Guest allergy UX regression, use the separately certified global `submit_order` privilege halt rather than an app-only rollback; restoring the old Guest application alone is not allergy-safe.

## Evidence and governance

- Release scope: FS-01A + FS-01B `main` SHA `893b6f543aeaf59332eef5aec9280e604419c8e0`.
- Backup PR: https://github.com/supportyeti-community/ting-app/pull/55.
- Record successful workflow run ID, encrypted artifact filename and manifest SHA256 in the canonical TinG Finish Sprint page after the first full verification succeeds.
- Git-linked Vercel may still create a new production deployment when a governance-only PR merges into `main`, despite `.vercelignore` excluding `.github/`, `scripts/` and `docs/`. Exclusions protect published static files, **not the deployment trigger**. Verify the deployed SHA and app unchanged; do not imply redeployment was prevented.

## Release gate

The backup/recovery risk can be marked **mitigated by certified logical recovery** only after an encrypted artifact exists, restore test passes and a second person or approved process can recover the decryption key. This is not equivalent to PITR or a complete Supabase managed-backup service.
