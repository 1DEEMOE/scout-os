-- Run once as a Postgres superuser: psql -U postgres -f scripts/setup-local-db.sql
-- wos_owner owns the app databases and runs migrations.
CREATE ROLE wos_owner LOGIN PASSWORD 'owner_dev_pw' NOBYPASSRLS;
CREATE ROLE app_user LOGIN PASSWORD 'app_dev_pw' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- wos_backup exists solely for scripts/backup.mjs. FORCE ROW LEVEL SECURITY
-- applies even to table owners, so dumping requires BYPASSRLS; keep that power
-- out of both the app role and the migration role.
CREATE ROLE wos_backup LOGIN PASSWORD 'backup_dev_pw' BYPASSRLS CREATEDB;
GRANT pg_read_all_data TO wos_backup;
CREATE DATABASE wos_dev OWNER wos_owner;
CREATE DATABASE wos_test OWNER wos_owner;
CREATE DATABASE wos_e2e OWNER wos_owner;
