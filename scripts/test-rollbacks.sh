#!/usr/bin/env bash
# Round-trip check: migrate up, run every rollback newest-first, migrate up,
# and require the schema (excluding pg-boss) to match the first pass.
# Usage: ADMIN_URL=postgres://postgres@127.0.0.1:5432 DB=scratch_db scripts/test-rollbacks.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ADMIN_URL:?}" "${DB:?}"
OWNER="postgres://wos_owner:owner_dev_pw@localhost:5432/$DB"
psql "$ADMIN_URL/postgres" -qc "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB OWNER wos_owner"
dump() { pg_dump "$ADMIN_URL/$DB" -s -N pgboss | grep -v '^\\\(un\)\?restrict'; }
DATABASE_URL_OWNER=$OWNER pnpm --filter @wos/db migrate >/dev/null
dump > /tmp/rb-up1.sql
for f in $(ls packages/db/rollback/*.down.sql | sort -r); do psql -v ON_ERROR_STOP=1 -q "$OWNER" -f "$f"; done
left=$(psql -At "$OWNER" -c "SELECT count(*) FROM schema_migrations WHERE name >= '0009'")
[ "$left" = 0 ] || { echo "FAIL: $left rolled-back migrations still recorded"; exit 1; }
DATABASE_URL_OWNER=$OWNER pnpm --filter @wos/db migrate >/dev/null
dump > /tmp/rb-up2.sql
diff /tmp/rb-up1.sql /tmp/rb-up2.sql && echo "PASS: rollback round-trip schema identical"
