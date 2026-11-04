-- 0001_roles.sql — database roles (ADR-0011). Runs as the container superuser.
--
-- Passwords are provided as session GUCs by scripts/roles.mjs / migrate.mjs
-- (never interpolated on the command line or written to logs).
--
--  evstation          superuser: bootstrap + dev/test seed only
--  evstation_owner    LOGIN, NOSUPERUSER, NOBYPASSRLS: owns schema/tables
--  evstation_app      LOGIN, NOSUPERUSER, NOBYPASSRLS: runtime DML only
--  evstation_definer  NOLOGIN, NOSUPERUSER, BYPASSRLS: owns DEFINER functions
--
-- The definer role is intentionally not granted to the owner (or anyone): the
-- owner must not be able to SET ROLE into a BYPASSRLS role. Only the
-- superuser (migrations/seed) can create/alter objects owned by it.

DO $roles$
DECLARE
  owner_pw text := current_setting('evstation.owner_password', true);
  app_pw text := current_setting('evstation.app_password', true);
BEGIN
  IF owner_pw IS NULL OR owner_pw = '' THEN
    RAISE EXCEPTION 'missing evstation.owner_password';
  END IF;
  IF app_pw IS NULL OR app_pw = '' THEN
    RAISE EXCEPTION 'missing evstation.app_password';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_owner') THEN
    EXECUTE format(
      'CREATE ROLE evstation_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
      owner_pw
    );
  END IF;
  EXECUTE format(
    'ALTER ROLE evstation_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
    owner_pw
  );

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_app') THEN
    EXECUTE format(
      'CREATE ROLE evstation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
      app_pw
    );
  END IF;
  EXECUTE format(
    'ALTER ROLE evstation_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
    app_pw
  );

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_definer') THEN
    CREATE ROLE evstation_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  ALTER ROLE evstation_definer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
END
$roles$;
