-- Run ONCE against the Render database as its default user (psql "$RENDER_EXTERNAL_DB_URL"),
-- before the first migration. Replace both passwords with long random values
-- (openssl rand -base64 32) and store them only in Render's environment settings.
--
-- UNVERIFIED on Render: this needs the default user to have CREATEROLE. If Render
-- refuses, create the two users in the dashboard instead and run the GRANTs.
CREATE ROLE wos_owner LOGIN PASSWORD 'REPLACE_ME_OWNER' NOBYPASSRLS;
CREATE ROLE app_user  LOGIN PASSWORD 'REPLACE_ME_APP' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- Migrations create tables as wos_owner; app_user gets only the grants the migrations give it.
GRANT ALL ON SCHEMA public TO wos_owner;
GRANT USAGE ON SCHEMA public TO app_user;
-- Then:  DATABASE_URL_OWNER=postgres://wos_owner:...@HOST/scout_os pnpm db:migrate
-- And set DATABASE_URL=postgres://app_user:...@HOST/scout_os on the web and worker services.
