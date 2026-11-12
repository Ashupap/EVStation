-- 0023_phase2_hardening.sql — review-required hardening for Phase 2a.
-- Keeps 0020-0022 immutable; all changes are additive.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

-- Runtime state is created atomically with the station, not by the client.
GRANT INSERT ON app.station_runtime_state TO evstation_definer;
CREATE OR REPLACE FUNCTION app.create_station_runtime_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  INSERT INTO app.station_runtime_state (station_id, tenant_id, site_id)
  VALUES (NEW.id, NEW.tenant_id, NEW.site_id)
  ON CONFLICT (station_id) DO NOTHING;
  RETURN NEW;
END
$fn$;
RESET ROLE;
ALTER FUNCTION app.create_station_runtime_state() OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.create_station_runtime_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_station_runtime_state() TO evstation_owner;
SET ROLE evstation_owner;
SET search_path = app, pg_catalog;
CREATE TRIGGER stations_create_runtime_state
  AFTER INSERT ON app.stations
  FOR EACH ROW EXECUTE FUNCTION app.create_station_runtime_state();

-- Remove direct credential/registration binding writes from the client role.
REVOKE UPDATE (csms_station_id, registration_status, credentials_state,
  registration_error, registration_attempts, last_registration_attempt_at)
  ON app.stations FROM evstation_app;
REVOKE UPDATE (csms_location_id) ON app.sites FROM evstation_app;

-- Definer-owned state transitions. Each function derives the tenant from the
-- station/site and requires a tenant admin/platform admin acting in that tenant.
GRANT SELECT, UPDATE (csms_station_id) ON app.stations TO evstation_definer;
GRANT SELECT, UPDATE (registration_status, csms_station_id, registration_error,
  registration_attempts, last_registration_attempt_at) ON app.stations TO evstation_definer;
GRANT SELECT, UPDATE (credentials_state) ON app.stations TO evstation_definer;
GRANT SELECT, UPDATE (csms_location_id) ON app.sites TO evstation_definer;

CREATE OR REPLACE FUNCTION app.set_station_csms_binding(p_station_id uuid, p_csms_station_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'station state requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.stations
  SET csms_station_id = p_csms_station_id
  WHERE id = p_station_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'station not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app.mark_station_registered(p_station_id uuid, p_csms_station_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'station state requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.stations
  SET registration_status = 'registered',
      csms_station_id = p_csms_station_id,
      registration_error = NULL,
      registration_attempts = registration_attempts + 1,
      last_registration_attempt_at = now()
  WHERE id = p_station_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'station not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app.mark_station_registration_failed(p_station_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'station state requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.stations
  SET registration_status = 'registration_failed',
      registration_error = left(p_error, 500),
      registration_attempts = registration_attempts + 1,
      last_registration_attempt_at = now()
  WHERE id = p_station_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'station not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app.mark_station_credentials_provisioned(p_station_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'station state requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.stations
  SET credentials_state = 'provisioned'
  WHERE id = p_station_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'station not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app.mark_station_rotation_incomplete(p_station_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'station state requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.stations
  SET credentials_state = 'rotation_incomplete'
  WHERE id = p_station_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'station not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app.set_site_csms_location(p_site_id uuid, p_csms_location_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.can_manage_tenant() THEN
    RAISE EXCEPTION 'site CSMS mapping requires tenant admin' USING ERRCODE = '42501';
  END IF;
  UPDATE app.sites
  SET csms_location_id = p_csms_location_id
  WHERE id = p_site_id AND tenant_id = app.tenant_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site not found' USING ERRCODE = '42501';
  END IF;
END
$fn$;

RESET ROLE;
DO $own$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname IN (
      'set_station_csms_binding', 'mark_station_registered',
      'mark_station_registration_failed', 'mark_station_credentials_provisioned',
      'mark_station_rotation_incomplete', 'set_site_csms_location'
    )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;
-- One live session per connector at a time.
CREATE UNIQUE INDEX sessions_one_live_per_connector
  ON app.sessions (connector_id)
  WHERE status IN ('starting', 'active');

-- Decommission model: deleting a site/station must not silently erase sessions
-- or meter values. The owner/migrator must resolve them explicitly.
ALTER TABLE app.sessions DROP CONSTRAINT sessions_station_scope_fk;
ALTER TABLE app.sessions ADD CONSTRAINT sessions_station_scope_fk
  FOREIGN KEY (station_id, tenant_id, site_id)
  REFERENCES app.stations (id, tenant_id, site_id) ON DELETE RESTRICT;
ALTER TABLE app.session_meter_values DROP CONSTRAINT session_meter_values_station_scope_fk;
ALTER TABLE app.session_meter_values ADD CONSTRAINT session_meter_values_station_scope_fk
  FOREIGN KEY (station_id, tenant_id, site_id)
  REFERENCES app.stations (id, tenant_id, site_id) ON DELETE RESTRICT;

RESET ROLE;
