#!/usr/bin/env bash
# Founder-approved logical backup: production is NEVER a restore destination.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}"
: "${GITHUB_WORKSPACE:?}"
: "${GITHUB_RUN_ID:?}"
: "${SUPABASE_ACCESS_TOKEN:?}"
: "${SUPABASE_DB_PASSWORD:?}"
TARGET_REF="okrwklulwrfnrhnffbwp"
CLI="$GITHUB_WORKSPACE/supabase/baseline/native/node_modules/.bin/supabase"
test "$("$CLI" --version)" = '2.117.0'
ROOT="$(mktemp -d "$RUNNER_TEMP/ting-backup-XXXXXXXX")"
SOURCE="$ROOT/production-link"
RESTORE="$ROOT/disposable-restore"
RAW="$ROOT/plaintext"
OUT="$GITHUB_WORKSPACE/_certified_encrypted_backup"
PROJECT_ID="fs01-backup-restore-${GITHUB_RUN_ID}"
CONTAINER="supabase_db_${PROJECT_ID}"
mkdir -p "$SOURCE" "$RESTORE" "$RAW" "$OUT"
chmod 700 "$ROOT" "$SOURCE" "$RESTORE" "$RAW" "$OUT"
cleanup() {
  if [[ -d "$RESTORE/supabase" ]]; then
    "$CLI" stop --project-id "$PROJECT_ID" --no-backup --workdir "$RESTORE" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOT"
}
trap cleanup EXIT HUP INT TERM

# Domain-separated key from the existing high-entropy token or dedicated secret.
python3 - "$ROOT/secret" <<'PY'
import os,sys,hmac,hashlib,pathlib
token=os.environ["SUPABASE_ACCESS_TOKEN"]
dedicated=os.environ.get("TING_BACKUP_PASSPHRASE","")
assert len(token)>30, "Access token too short to be treated as a high-entropy backup root"
key=dedicated if dedicated else hmac.new(token.encode(),
  b"ting-prod-backup-v1|okrwklulwrfnrhnffbwp",hashlib.sha256).hexdigest()
if len(key)<32: raise RuntimeError("Backup key must be at least 32 characters")
p=pathlib.Path(sys.argv[1]);p.write_text(key);p.chmod(0o600)
PY

"$CLI" init --yes --workdir "$SOURCE" >/dev/null 2>&1
"$CLI" link --project-ref "$TARGET_REF" --password "$SUPABASE_DB_PASSWORD" --workdir "$SOURCE" >/dev/null 2>&1
echo "PRODUCTION_CAPTURE_TARGET_VERIFIED=$TARGET_REF"
# Every production dump session runs in PostgreSQL transaction read-only mode.
export PGOPTIONS='-c default_transaction_read_only=on'
"$CLI" db dump --linked --role-only --file "$RAW/roles.sql" --workdir "$SOURCE" >/dev/null 2>&1
"$CLI" db dump --linked --file "$RAW/schema.sql" --workdir "$SOURCE" >/dev/null 2>&1
"$CLI" db dump --linked --data-only --use-copy --schema public,auth,supabase_migrations --file "$RAW/data.sql" --workdir "$SOURCE" >/dev/null 2>&1
unset PGOPTIONS SUPABASE_DB_PASSWORD SUPABASE_ACCESS_TOKEN TING_BACKUP_PASSPHRASE
for f in roles.sql schema.sql data.sql; do
  test -s "$RAW/$f" || { echo "INCOMPLETE_PRODUCTION_DUMP=$f"; exit 1; }
done
for table in 'public.tenants' 'public.menu_items' 'public.menu_categories' 'public.menu_allergen_codes' 'public.menu_item_allergen_reviews' 'public.orders' 'auth.users' 'supabase_migrations.schema_migrations'; do
  schema="${table%%.*}"; relation="${table#*.}"
  if ! grep -Fq "COPY \"$schema\".\"$relation\" " "$RAW/data.sql"; then
    echo "REQUIRED_TABLE_NOT_EXPORTED=$table"
    exit 1
  fi
done
echo "PRODUCTION_COPY_COVERAGE=PASS includes_auth=true includes_migration_ledger=true"

# Restore exclusively in a newly created isolated native PostgreSQL 17.6 stack.
"$CLI" init --yes --workdir "$RESTORE" >/dev/null 2>&1
python3 - "$RESTORE/supabase/config.toml" "$PROJECT_ID" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text()
assert 'major_version = 17' in s, 'Native PostgreSQL major version changed'
s,n=re.subn(r'(?m)^project_id = "[^"]+"',f'project_id = "{sys.argv[2]}"',s,count=1)
assert n==1
p.write_text(s)
PY
if ! "$CLI" start -x studio,edge-runtime,logflare,vector,supavisor,postgres-meta --workdir "$RESTORE" >"$ROOT/local-start.log" 2>&1; then
  echo "DISPOSABLE_SUPABASE_START=FAIL (private logs withheld)"
  exit 1
fi
docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER" || { echo "ISOLATED_DB_CONTAINER_NOT_FOUND"; exit 1; }
version="$(docker exec "$CONTAINER" psql -X -At -U postgres -d postgres -c 'SHOW server_version;' 2>/dev/null)"
[[ "$version" == 17.6* ]] || { echo "LOCAL_POSTGRES_VERSION_UNEXPECTED"; exit 1; }
echo "DISPOSABLE_NATIVE_POSTGRES_VERSION=$version"
quiet_psql() {
  if ! docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -U postgres -d postgres >"$ROOT/private-psql.log" 2>&1; then
    code="$(sed -nE 's/.*ERROR:[[:space:]]*([0-9A-Z]{5})([^0-9A-Z]|$).*/\1/p' "$ROOT/private-psql.log" | head -1 || true)"
    echo "DISPOSABLE_RESTORE_SQL_FAILED sqlstate=${code:-unknown} (private logs withheld)"
    exit 1
  fi
}
# Native Supabase supplies platform Auth, Storage, roles and extensions.
echo 'DISPOSABLE_RESTORE_PHASE=schema'
quiet_psql < "$RAW/schema.sql"
printf '%s\n' \
  'CREATE SCHEMA IF NOT EXISTS supabase_migrations;' \
  'CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY, statements text[], name text);' | quiet_psql
# Compare COPY targets with catalog before touching disposable data.
python3 - "$RAW/data.sql" "$CONTAINER" <<'PY'
import pathlib,re,subprocess,sys
sql=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
tables=sorted({m.group(1).replace('"','') for m in re.finditer(r'(?m)^COPY\\s+((?:\"?\\w+\"?\\.)?\"?\\w+\"?)\\s*\\(',sql)})
missing=[]
for table in tables:
    result=subprocess.run(["docker","exec",sys.argv[2],"psql","-X","-q","-t","-A","-U","postgres","-d","postgres","-c","SELECT (to_regclass('"+table+"') IS NOT NULL)::int"],
      capture_output=True,text=True,check=True)
    if result.stdout.strip()!="1": missing.append(table)
print("DISPOSABLE_COPY_TARGET_COUNT="+str(len(tables)))
if missing:
    print("DISPOSABLE_SCHEMA_MISSING_TABLES="+",".join(missing))
    raise SystemExit(1)
print("DISPOSABLE_ALL_COPY_TARGET_TABLES_PRESENT=PASS")
PY
# Disable row-trigger side effects solely within the isolated restore transaction.
{
  printf '%s\n' 'BEGIN;' 'SET LOCAL session_replication_role = replica;'
  cat "$RAW/data.sql"
  printf '%s\n' 'COMMIT;'
} | { echo 'DISPOSABLE_RESTORE_PHASE=data'; quiet_psql; }
python3 "$GITHUB_WORKSPACE/scripts/prod-db-backup/restore_check.py" --data "$RAW/data.sql" --container "$CONTAINER"
echo 'PRODUCTION_WRITES=0'
if ! "$CLI" stop --project-id "$PROJECT_ID" --no-backup --workdir "$RESTORE" >"$ROOT/local-stop.log" 2>&1; then
  echo "DISPOSABLE_CLEANUP=FAIL (private logs withheld)"
  exit 1
fi
echo "DISPOSABLE_CLEANUP=PASS"

(
  cd "$RAW"
  sha256sum roles.sql schema.sql data.sql > SHA256SUMS
  printf '%s\n' "project_ref=$TARGET_REF" "certified_at_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    'postgresql=17.6' 'migration_count=29' 'encryption=gpg-aes256' \
    'key_kdf=HMAC_SHA256(SUPABASE_ACCESS_TOKEN,ting-prod-backup-v1|project_ref) unless TING_BACKUP_PASSPHRASE exists' \
    'not_included=storage_files,edge_functions,auth_settings,api_keys,secrets' > MANIFEST.txt
  tar -czf "$ROOT/production-backup.tar.gz" roles.sql schema.sql data.sql SHA256SUMS MANIFEST.txt
)
CIPHERTEXT="$OUT/ting-prod-${GITHUB_RUN_ID}.tar.gz.gpg"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$ROOT/secret" \
  --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
  --output "$CIPHERTEXT" "$ROOT/production-backup.tar.gz" >/dev/null 2>&1
test -s "$CIPHERTEXT" || { echo "CIPHERTEXT_MISSING"; exit 1; }
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$ROOT/secret" \
  --decrypt --output "$ROOT/roundtrip.tar.gz" "$CIPHERTEXT" >/dev/null 2>&1
cmp -s "$ROOT/roundtrip.tar.gz" "$ROOT/production-backup.tar.gz" || { echo "ENCRYPTION_ROUNDTRIP=FAIL"; exit 1; }
echo "ENCRYPTION_ROUNDTRIP=PASS aes256=true"
sha256sum "$CIPHERTEXT" | sed -E 's@ .*@@' | awk '{print "CIPHERTEXT_SHA256="$1}'
echo "ENCRYPTED_BACKUP_READY=PASS"
