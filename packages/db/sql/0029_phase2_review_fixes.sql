-- 0029_phase2_review_fixes.sql — PR 2a re-review fixes.
-- Keep 0020-0022 additive; this migration applies the review corrections.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

REVOKE INSERT (registration_status, registration_error, registration_attempts,
  last_registration_attempt_at) ON app.stations FROM evstation_app;

DROP POLICY stations_insert ON app.stations;
CREATE POLICY stations_insert ON app.stations FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

DROP POLICY connectors_insert ON app.connectors;
CREATE POLICY connectors_insert ON app.connectors FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

CREATE UNIQUE INDEX stations_csms_station_id_key
  ON app.stations (csms_station_id)
  WHERE csms_station_id IS NOT NULL;

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE OR REPLACE FUNCTION app.ensure_event_partition(p_parent text, p_month date)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  parent_name text := p_parent;
  default_name text;
  new_name text;
  month_start timestamptz;
  month_end timestamptz;
BEGIN
  IF parent_name NOT IN ('session_meter_values', 'station_status_events', 'ingestion_events') THEN
    RAISE EXCEPTION 'unsupported event parent: %', parent_name;
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'p_month must be the first day of a month';
  END IF;

  default_name := parent_name || '_default';
  new_name := parent_name || '_' || to_char(p_month, 'YYYY_MM');
  month_start := p_month::timestamp AT TIME ZONE 'UTC';
  month_end := (p_month + interval '1 month')::timestamp AT TIME ZONE 'UTC';

  IF to_regclass(format('app.%I', new_name)) IS NOT NULL THEN
    RETURN;
  END IF;

  IF to_regclass(format('app.%I', default_name)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app.%I DETACH PARTITION app.%I', parent_name, default_name);
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    new_name, parent_name, month_start, month_end
  );

  IF to_regclass(format('app.%I', default_name)) IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO app.%I OVERRIDING SYSTEM VALUE SELECT * FROM app.%I WHERE csms_timestamp >= %L AND csms_timestamp < %L',
      parent_name, default_name, month_start, month_end
    );
    EXECUTE format(
      'DELETE FROM app.%I WHERE csms_timestamp >= %L AND csms_timestamp < %L',
      default_name, month_start, month_end
    );
    EXECUTE format('ALTER TABLE app.%I ATTACH PARTITION app.%I DEFAULT', parent_name, default_name);
  END IF;

  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', new_name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', new_name);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', new_name);
  EXECUTE format('REVOKE ALL ON app.%I FROM evstation_app', new_name);
END
$fn$;

RESET ROLE;
