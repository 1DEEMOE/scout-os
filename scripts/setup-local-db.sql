-- Run once as a Postgres superuser: psql -U postgres -f scripts/setup-local-db.sql
CREATE ROLE wos_owner LOGIN PASSWORD 'owner_dev_pw' NOBYPASSRLS;
CREATE ROLE app_user LOGIN PASSWORD 'app_dev_pw' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE wos_dev OWNER wos_owner;
CREATE DATABASE wos_test OWNER wos_owner;
CREATE DATABASE wos_e2e OWNER wos_owner;
