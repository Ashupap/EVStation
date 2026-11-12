-- 0021_phase2_stations.sql — Phase 2 station registry, runtime state and connectors.
-- Registration/config is deliberately separate from volatile runtime state.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

ALTER TABLE app.sites ADD COLUMN csms_location_id integer;

CREATE TABLE app.stations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  site_id                 uuid NOT NULL,
  org_code                text NOT NULL,
  station_ref             text NOT NULL UNIQUE,
  registration_status     text NOT NULL DEFAULT 'pending'
                            CHECK (registration_status IN ('pending', 'registered', 'registration_failed', 'decommissioned')),
  credentials_state       text NOT NULL DEFAULT 'none'
                            CHECK (credentials_state IN ('none', 'provisioned', 'rotation_incomplete')),
  csms_station_id         integer,
  vendor                  text,
  model                   text,
  serial                  text,
  firmware_version        text,
  ocpp_version            text NOT NULL DEFAULT 'ocpp1.6' CHECK (ocpp_version = 'ocpp1.6'),
  registration_error      text,
  registration_attempts   integer NOT NULL DEFAULT 0 CHECK (registration_attempts >= 0),
  last_registration_attempt_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stations_ref_format CHECK (
    length(station_ref) BETWEEN 8 AND 20
    AND station_ref ~ '^[A-Z0-9]+-[A-Z0-9]+-[0-9]{3}$'
  ),
  CONSTRAINT stations_id_tenant_site_key UNIQUE (id, tenant_id, site_id),
  CONSTRAINT stations_site_fk FOREIGN KEY (site_id, tenant_id)
    REFERENCES app.sites (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT stations_tenant_org_fk FOREIGN KEY (tenant_id, org_code)
    REFERENCES app.tenants (id, org_code)
);
CREATE INDEX stations_tenant_site_ref_idx ON app.stations (tenant_id, site_id, station_ref);
CREATE INDEX stations_tenant_registration_idx ON app.stations (tenant_id, registration_status);

CREATE TABLE app.station_runtime_state (
  station_id          uuid PRIMARY KEY REFERENCES app.stations (id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL,
  site_id             uuid NOT NULL,
  connection_state    text NOT NULL DEFAULT 'unknown'
                        CHECK (connection_state IN ('unknown', 'connected', 'disconnected')),
  last_heartbeat_at   timestamptz,
  last_connected_at   timestamptz,
  last_disconnected_at timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT station_runtime_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE
);
CREATE INDEX station_runtime_tenant_heartbeat_idx
  ON app.station_runtime_state (tenant_id, last_heartbeat_at DESC);

CREATE TABLE app.connectors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  site_id             uuid NOT NULL,
  station_id          uuid NOT NULL,
  connector_number    integer NOT NULL CHECK (connector_number > 0),
  type                text,
  max_power_w         integer CHECK (max_power_w IS NULL OR max_power_w > 0),
  status              text NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('unknown', 'available', 'preparing', 'charging', 'suspended_ev',
                                          'suspended_evse', 'finishing', 'reserved', 'unavailable', 'faulted')),
  error_code          text,
  last_status_at      timestamptz,
  csms_evse_id        integer,
  csms_connector_id   integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connectors_station_number_key UNIQUE (station_id, connector_number),
  CONSTRAINT connectors_id_scope_key UNIQUE (id, station_id, tenant_id, site_id),
  CONSTRAINT connectors_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX connectors_station_csms_connector_key
  ON app.connectors (station_id, csms_connector_id)
  WHERE csms_connector_id IS NOT NULL;
CREATE INDEX connectors_tenant_station_idx ON app.connectors (tenant_id, station_id);

CREATE OR REPLACE FUNCTION app.validate_station_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  tenant_org text;
  site_org text;
  bound_site_code text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.station_ref IS DISTINCT FROM OLD.station_ref
          OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
          OR NEW.site_id IS DISTINCT FROM OLD.site_id
          OR NEW.org_code IS DISTINCT FROM OLD.org_code) THEN
    RAISE EXCEPTION 'station identity is immutable';
  END IF;

  IF length(NEW.station_ref) NOT BETWEEN 8 AND 20
     OR NEW.station_ref !~ '^[A-Z0-9]+-[A-Z0-9]+-[0-9]{3}$' THEN
    RAISE EXCEPTION 'station_ref format is invalid';
  END IF;

  SELECT t.org_code INTO tenant_org FROM app.tenants t WHERE t.id = NEW.tenant_id;
  SELECT s.site_code, s.tenant_id::text INTO bound_site_code, site_org
  FROM app.sites s WHERE s.id = NEW.site_id;

  IF tenant_org IS NULL OR bound_site_code IS NULL OR site_org IS DISTINCT FROM NEW.tenant_id::text THEN
    RAISE EXCEPTION 'station tenant/site binding is invalid';
  END IF;
  IF NEW.org_code IS DISTINCT FROM tenant_org THEN
    RAISE EXCEPTION 'station ORG segment must equal the tenant org_code';
  END IF;
  IF split_part(NEW.station_ref, '-', 1) IS DISTINCT FROM tenant_org THEN
    RAISE EXCEPTION 'station_ref ORG segment must equal the tenant org_code';
  END IF;
  IF split_part(NEW.station_ref, '-', 2) IS DISTINCT FROM bound_site_code THEN
    RAISE EXCEPTION 'station_ref SITE segment must equal the site_code';
  END IF;
  RETURN NEW;
END
$fn$;
RESET ROLE;
ALTER FUNCTION app.validate_station_identity() OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.validate_station_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_station_identity() TO evstation_owner;
SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE TRIGGER stations_validate_identity
  BEFORE INSERT OR UPDATE ON app.stations
  FOR EACH ROW EXECUTE FUNCTION app.validate_station_identity();

CREATE TRIGGER stations_touch_updated_at
  BEFORE UPDATE ON app.stations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER connectors_touch_updated_at
  BEFORE UPDATE ON app.connectors
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE app.stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.station_runtime_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.station_runtime_state FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connectors FORCE ROW LEVEL SECURITY;

CREATE POLICY stations_select ON app.stations
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );
CREATE POLICY stations_insert ON app.stations
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  );
CREATE POLICY stations_update ON app.stations
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  );

CREATE POLICY station_runtime_select ON app.station_runtime_state
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );

CREATE POLICY connectors_select ON app.connectors
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );
CREATE POLICY connectors_insert ON app.connectors
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  );
CREATE POLICY connectors_update ON app.connectors
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR ((SELECT app.actor_role()) = 'site_manager'
          AND site_id = ANY (((SELECT app.actor_site_ids()))::uuid[]))
    )
  );

REVOKE ALL ON app.stations, app.station_runtime_state, app.connectors FROM PUBLIC;
GRANT SELECT ON app.stations, app.station_runtime_state, app.connectors TO evstation_app;
GRANT INSERT (tenant_id, site_id, org_code, station_ref, registration_status, vendor, model, serial,
  firmware_version, ocpp_version, registration_error, registration_attempts, last_registration_attempt_at)
  ON app.stations TO evstation_app;
GRANT UPDATE (registration_status, credentials_state, csms_station_id, vendor, model, serial,
  firmware_version, registration_error, registration_attempts, last_registration_attempt_at)
  ON app.stations TO evstation_app;
GRANT INSERT (tenant_id, site_id, station_id, connector_number, type, max_power_w, status,
  error_code, last_status_at, csms_evse_id, csms_connector_id) ON app.connectors TO evstation_app;
GRANT UPDATE (type, max_power_w, status, error_code, last_status_at, csms_evse_id, csms_connector_id)
  ON app.connectors TO evstation_app;
GRANT UPDATE (csms_location_id) ON app.sites TO evstation_app;

RESET ROLE;
