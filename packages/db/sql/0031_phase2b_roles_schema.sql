-- 0031_phase2b_roles_schema.sql — Phase 2b roles, event ownership and columns.
-- 0020-0030 are immutable; this file only adds objects/columns.

-- ── Roles ────────────────────────────────────────────────────────────────
DO $roles$
DECLARE
  ingest_pw text := current_setting('evstation.ingest_password', true);
  jobs_pw text := current_setting('evstation.jobs_password', true);
BEGIN
  IF ingest_pw IS NULL OR ingest_pw = '' THEN RAISE EXCEPTION 'missing evstation.ingest_password'; END IF;
  IF jobs_pw IS NULL OR jobs_pw = '' THEN RAISE EXCEPTION 'missing evstation.jobs_password'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_ingest') THEN
    CREATE ROLE evstation_ingest LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('ALTER ROLE evstation_ingest WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', ingest_pw);

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_jobs') THEN
    CREATE ROLE evstation_jobs LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  EXECUTE format('ALTER ROLE evstation_jobs WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', jobs_pw);

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_ingest_definer') THEN
    CREATE ROLE evstation_ingest_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  ALTER ROLE evstation_ingest_definer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evstation_event_owner') THEN
    CREATE ROLE evstation_event_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  ALTER ROLE evstation_event_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
END
$roles$;

GRANT evstation_event_owner TO evstation_owner;
GRANT USAGE ON SCHEMA app TO evstation_ingest, evstation_jobs, evstation_ingest_definer, evstation_event_owner;
GRANT CREATE ON SCHEMA app TO evstation_event_owner;

-- ── Schema additions ─────────────────────────────────────────────────────
SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

ALTER TABLE app.stations
  ADD COLUMN reported_vendor text,
  ADD COLUMN reported_model text,
  ADD COLUMN reported_serial text,
  ADD COLUMN reported_firmware text,
  ADD COLUMN last_boot_at timestamptz;
ALTER TABLE app.station_runtime_state
  ADD COLUMN last_event_csms_at timestamptz,
  ADD COLUMN last_seen_at timestamptz;
ALTER TABLE app.connectors
  ADD COLUMN last_event_csms_at timestamptz;
ALTER TABLE app.pending_transaction_starts
  ADD COLUMN charger_reported_at timestamptz,
  ADD COLUMN started_at_source text NOT NULL DEFAULT 'csms'
    CHECK (started_at_source IN ('charger', 'csms'));
ALTER TABLE app.sessions
  ADD COLUMN meter_start_wh bigint NOT NULL DEFAULT 0 CHECK (meter_start_wh >= 0),
  ADD COLUMN charger_started_at timestamptz,
  ADD COLUMN charger_ended_at timestamptz,
  ADD COLUMN started_at_source text NOT NULL DEFAULT 'csms' CHECK (started_at_source IN ('charger', 'csms')),
  ADD COLUMN ended_at_source text CHECK (ended_at_source IS NULL OR ended_at_source IN ('charger', 'csms'));

ALTER TABLE app.ingestion_events
  ADD CONSTRAINT ingestion_events_station_ref_format
  CHECK (station_ref ~ '^[A-Z0-9-]{1,64}$');

CREATE TABLE app.ingestion_rejections (
  station_ref      text NOT NULL CHECK (station_ref ~ '^[A-Z0-9-]{1,64}$'),
  reason_code      text NOT NULL,
  day              date NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_ref, reason_code, day)
);
ALTER TABLE app.ingestion_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ingestion_rejections FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.ingestion_rejections FROM PUBLIC;
REVOKE ALL ON app.ingestion_rejections FROM evstation_app, evstation_ingest, evstation_jobs;

-- Event trees move to the dedicated BYPASSRLS owner. App grants/policies stay.
RESET ROLE;
DO $reown$
DECLARE
  rel regclass;
BEGIN
  FOR rel IN
    SELECT c.oid::regclass
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relname IN ('session_meter_values', 'station_status_events', 'ingestion_events')
    UNION
    SELECT c.oid::regclass
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE n.nspname = 'app'
      AND p.relname IN ('session_meter_values', 'station_status_events', 'ingestion_events')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO evstation_event_owner', rel);
  END LOOP;
  FOR rel IN
    SELECT c.oid::regclass
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relkind = 'S'
      AND EXISTS (
        SELECT 1 FROM pg_depend d
        JOIN pg_class t ON t.oid = d.refobjid
        WHERE d.objid = c.oid AND d.deptype = 'i'
          AND t.relname IN ('session_meter_values', 'station_status_events', 'ingestion_events')
      )
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO evstation_event_owner', rel);
  END LOOP;
END
$reown$;

ALTER FUNCTION app.ensure_event_partition(text, date) OWNER TO evstation_event_owner;
ALTER FUNCTION app.ensure_event_partition(text, date) SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.ensure_event_partition(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_event_partition(text, date) TO evstation_jobs;

-- Defininer role gets only the table privileges used by ingest functions.
GRANT SELECT, INSERT, UPDATE ON app.stations TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.station_runtime_state TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.connectors TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.sessions TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.session_meter_values TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.station_status_events TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.pending_transaction_starts TO evstation_ingest_definer;
GRANT SELECT, INSERT, UPDATE ON app.ingestion_events TO evstation_ingest_definer;
GRANT SELECT ON app.ingestion_events TO evstation_app;
GRANT INSERT ON app.connectors TO evstation_app;
CREATE POLICY ingestion_events_select ON app.ingestion_events
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );
GRANT SELECT, INSERT, UPDATE ON app.ingestion_rejections TO evstation_ingest_definer;
GRANT SELECT ON app.sites TO evstation_ingest_definer;

RESET ROLE;
