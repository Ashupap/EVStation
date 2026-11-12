-- 0022_phase2_sessions_events.sql — sessions, meter values, status history,
-- pending starts and the ingestion ledger. Event tables are partitioned by the
-- deterministic CitrineOS envelope timestamp; partitions are created monthly.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE TABLE app.sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  site_id                   uuid NOT NULL,
  station_id                uuid NOT NULL,
  connector_id              uuid NOT NULL,
  csms_transaction_ref      text,
  csms_start_correlation_id text,
  id_tag                    text,
  started_at                timestamptz NOT NULL,
  ended_at                  timestamptz,
  energy_wh                 bigint NOT NULL DEFAULT 0 CHECK (energy_wh >= 0),
  status                    text NOT NULL DEFAULT 'starting'
                              CHECK (status IN ('starting', 'active', 'completed', 'failed')),
  stop_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_id_scope_key UNIQUE (id, tenant_id, site_id),
  CONSTRAINT sessions_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT sessions_connector_scope_fk
    FOREIGN KEY (connector_id, station_id, tenant_id, site_id)
    REFERENCES app.connectors (id, station_id, tenant_id, site_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX sessions_station_transaction_key
  ON app.sessions (station_id, csms_transaction_ref)
  WHERE csms_transaction_ref IS NOT NULL;
CREATE UNIQUE INDEX sessions_station_start_correlation_key
  ON app.sessions (station_id, csms_start_correlation_id)
  WHERE csms_start_correlation_id IS NOT NULL;
CREATE INDEX sessions_tenant_started_idx
  ON app.sessions (tenant_id, started_at DESC, id DESC);
CREATE INDEX sessions_tenant_site_started_idx
  ON app.sessions (tenant_id, site_id, started_at DESC, id DESC);
CREATE INDEX sessions_tenant_station_started_idx
  ON app.sessions (tenant_id, station_id, started_at DESC, id DESC);

CREATE TABLE app.session_meter_values (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id           uuid NOT NULL,
  site_id             uuid NOT NULL,
  station_id          uuid NOT NULL,
  session_id          uuid NOT NULL,
  csms_event_ref      text NOT NULL,
  csms_timestamp      timestamptz NOT NULL,
  charger_reported_at timestamptz,
  received_at         timestamptz NOT NULL DEFAULT now(),
  energy_wh           bigint CHECK (energy_wh IS NULL OR energy_wh >= 0),
  power_w             integer,
  PRIMARY KEY (id, csms_timestamp),
  CONSTRAINT session_meter_values_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT session_meter_values_session_scope_fk
    FOREIGN KEY (session_id, tenant_id, site_id)
    REFERENCES app.sessions (id, tenant_id, site_id) ON DELETE CASCADE
) PARTITION BY RANGE (csms_timestamp);
CREATE UNIQUE INDEX session_meter_values_event_key
  ON app.session_meter_values (station_id, csms_event_ref, csms_timestamp);
CREATE INDEX session_meter_values_tenant_time_idx
  ON app.session_meter_values (tenant_id, csms_timestamp DESC, id DESC);
CREATE INDEX session_meter_values_tenant_site_time_idx
  ON app.session_meter_values (tenant_id, site_id, csms_timestamp DESC, id DESC);
CREATE INDEX session_meter_values_tenant_session_time_idx
  ON app.session_meter_values (tenant_id, session_id, csms_timestamp DESC, id DESC);

CREATE TABLE app.station_status_events (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id           uuid NOT NULL,
  site_id             uuid NOT NULL,
  station_id          uuid NOT NULL,
  connector_id        uuid,
  status              text NOT NULL
                        CHECK (status IN ('unknown', 'available', 'preparing', 'charging', 'suspended_ev',
                                          'suspended_evse', 'finishing', 'reserved', 'unavailable', 'faulted')),
  error_code          text,
  csms_event_ref      text NOT NULL,
  csms_timestamp      timestamptz NOT NULL,
  charger_reported_at timestamptz,
  received_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, csms_timestamp),
  CONSTRAINT station_status_events_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT station_status_events_connector_scope_fk
    FOREIGN KEY (connector_id, station_id, tenant_id, site_id)
    REFERENCES app.connectors (id, station_id, tenant_id, site_id) ON DELETE CASCADE
) PARTITION BY RANGE (csms_timestamp);
CREATE UNIQUE INDEX station_status_events_event_key
  ON app.station_status_events (station_id, csms_event_ref, csms_timestamp);
CREATE INDEX station_status_events_tenant_time_idx
  ON app.station_status_events (tenant_id, csms_timestamp DESC, id DESC);
CREATE INDEX station_status_events_tenant_site_time_idx
  ON app.station_status_events (tenant_id, site_id, csms_timestamp DESC, id DESC);
CREATE INDEX station_status_events_tenant_station_time_idx
  ON app.station_status_events (tenant_id, station_id, csms_timestamp DESC, id DESC);

CREATE TABLE app.pending_transaction_starts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  site_id                   uuid NOT NULL,
  station_id                uuid NOT NULL,
  connector_id              uuid NOT NULL,
  csms_start_correlation_id text NOT NULL UNIQUE,
  id_tag                    text,
  meter_start_wh            bigint NOT NULL CHECK (meter_start_wh >= 0),
  started_at                timestamptz NOT NULL,
  csms_timestamp            timestamptz NOT NULL,
  received_at               timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL,
  attempts                  integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  CONSTRAINT pending_starts_station_scope_fk
    FOREIGN KEY (station_id, tenant_id, site_id)
    REFERENCES app.stations (id, tenant_id, site_id) ON DELETE CASCADE,
  CONSTRAINT pending_starts_connector_scope_fk
    FOREIGN KEY (connector_id, station_id, tenant_id, site_id)
    REFERENCES app.connectors (id, station_id, tenant_id, site_id) ON DELETE CASCADE
);
CREATE INDEX pending_starts_expiry_idx ON app.pending_transaction_starts (expires_at);

CREATE TABLE app.ingestion_events (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  station_ref         text NOT NULL,
  tenant_id           uuid,
  site_id             uuid,
  kind                text NOT NULL,
  csms_event_ref      text NOT NULL,
  csms_timestamp      timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  outcome             text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'parked')),
  reason_code         text,
  payload_hash        text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  occurrence_count    integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  PRIMARY KEY (id, csms_timestamp)
) PARTITION BY RANGE (csms_timestamp);
CREATE UNIQUE INDEX ingestion_events_event_key
  ON app.ingestion_events (station_ref, csms_event_ref, csms_timestamp, outcome);
CREATE INDEX ingestion_events_station_time_idx
  ON app.ingestion_events (station_ref, csms_timestamp DESC, id DESC);

-- Explicit monthly partitions for the Phase 2 evidence window, plus a default
-- partition so late/out-of-window events are never dropped. The maintenance job
-- creates future monthly partitions; the default remains as a safety net.
CREATE TABLE app.session_meter_values_2026_11 PARTITION OF app.session_meter_values
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE app.session_meter_values_2026_12 PARTITION OF app.session_meter_values
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE app.session_meter_values_2027_01 PARTITION OF app.session_meter_values
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE app.session_meter_values_default PARTITION OF app.session_meter_values DEFAULT;

CREATE TABLE app.station_status_events_2026_11 PARTITION OF app.station_status_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE app.station_status_events_2026_12 PARTITION OF app.station_status_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE app.station_status_events_2027_01 PARTITION OF app.station_status_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE app.station_status_events_default PARTITION OF app.station_status_events DEFAULT;

CREATE TABLE app.ingestion_events_2026_11 PARTITION OF app.ingestion_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE app.ingestion_events_2026_12 PARTITION OF app.ingestion_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');
CREATE TABLE app.ingestion_events_2027_01 PARTITION OF app.ingestion_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');
CREATE TABLE app.ingestion_events_default PARTITION OF app.ingestion_events DEFAULT;

ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.session_meter_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.session_meter_values FORCE ROW LEVEL SECURITY;
ALTER TABLE app.station_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.station_status_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pending_transaction_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pending_transaction_starts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ingestion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ingestion_events FORCE ROW LEVEL SECURITY;

DO $partitions$
DECLARE
  child regclass;
BEGIN
  FOR child IN
    SELECT c.oid::regclass FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app'
      AND p.relname IN ('session_meter_values', 'station_status_events', 'ingestion_events')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', child);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', child);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', child);
  END LOOP;
END
$partitions$;

CREATE POLICY sessions_select ON app.sessions
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );
CREATE POLICY session_meter_values_select ON app.session_meter_values
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );
CREATE POLICY station_status_events_select ON app.station_status_events
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR site_id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );

REVOKE ALL ON app.sessions, app.session_meter_values, app.station_status_events,
  app.pending_transaction_starts, app.ingestion_events FROM PUBLIC;
GRANT SELECT ON app.sessions, app.session_meter_values, app.station_status_events TO evstation_app;

RESET ROLE;
