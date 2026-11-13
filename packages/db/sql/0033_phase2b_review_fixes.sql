-- 0032_phase2b_ingest_functions.sql — narrow SECURITY DEFINER ingestion and job functions.
-- All tenant/site values are derived from station_ref. No caller tenant/site params.

SET search_path = pg_catalog, app, pg_temp;

CREATE OR REPLACE FUNCTION app.ingest_station(p_station_ref text)
RETURNS TABLE(id uuid, tenant_id uuid, site_id uuid, registration_status text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT s.id, s.tenant_id, s.site_id, s.registration_status
  FROM app.stations s WHERE s.station_ref = p_station_ref
$fn$;

CREATE OR REPLACE FUNCTION app.touch_station_liveness(
  p_station_id uuid, p_csms_timestamp timestamptz, p_revive boolean DEFAULT true
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  UPDATE app.station_runtime_state
  SET last_seen_at = CASE
        WHEN last_seen_at IS NULL OR now() - last_seen_at >= interval '30 seconds' THEN now()
        ELSE last_seen_at END,
      last_event_csms_at = greatest(coalesce(last_event_csms_at, p_csms_timestamp), p_csms_timestamp),
      connection_state = CASE
        WHEN p_revive AND connection_state = 'disconnected'
          AND (last_disconnected_at IS NULL OR p_csms_timestamp > last_disconnected_at)
        THEN 'connected' ELSE connection_state END,
      updated_at = now()
  WHERE station_id = p_station_id;
END
$fn$;

CREATE OR REPLACE FUNCTION app.reject_ingest_event(
  p_station_ref text, p_reason text, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  v_ref text := left(upper(coalesce(p_station_ref, '')), 64);
BEGIN
  IF v_ref !~ '^[A-Z0-9-]{1,64}$' THEN v_ref := 'INVALID'; END IF;
  INSERT INTO app.ingestion_rejections (station_ref, reason_code, day, occurrence_count, first_seen_at, last_seen_at)
  VALUES (v_ref, p_reason, current_date, 1, now(), now())
  ON CONFLICT (station_ref, reason_code, day) DO UPDATE
    SET occurrence_count = app.ingestion_rejections.occurrence_count + 1,
        last_seen_at = now();
  RETURN 'rejected';
END
$fn$;

CREATE OR REPLACE FUNCTION app.record_parked_event(
  p_station_ref text, p_event_ref text, p_csms_timestamp timestamptz,
  p_kind text, p_reason text, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  s record;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN
    RETURN app.reject_ingest_event(p_station_ref, p_reason, p_payload_hash);
  END IF;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, p_kind, p_event_ref, p_csms_timestamp, 'parked', p_reason, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'parked';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_boot(
  p_station_ref text, p_event_ref text, p_csms_timestamp timestamptz,
  p_charger_timestamp timestamptz, p_vendor text, p_model text, p_serial text,
  p_firmware text, p_protocol text, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  IF s.registration_status = 'decommissioned' THEN RETURN app.reject_ingest_event(p_station_ref, 'STATION_DECOMMISSIONED', p_payload_hash); END IF;
  IF p_protocol IS DISTINCT FROM 'ocpp1.6' THEN RETURN app.reject_ingest_event(p_station_ref, 'UNSUPPORTED_OCPP_VERSION', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  UPDATE app.stations
  SET reported_vendor = left(p_vendor, 200), reported_model = left(p_model, 200),
      reported_serial = left(p_serial, 200), reported_firmware = left(p_firmware, 200),
      last_boot_at = p_csms_timestamp
  WHERE id = s.id;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'boot', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_connection(
  p_station_ref text, p_state text, p_event_ref text, p_csms_timestamp timestamptz,
  p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  IF s.registration_status = 'decommissioned' THEN RETURN app.reject_ingest_event(p_station_ref, 'STATION_DECOMMISSIONED', p_payload_hash); END IF;
  IF p_state NOT IN ('connected', 'closed') THEN
    RETURN app.reject_ingest_event(p_station_ref, 'MALFORMED_PAYLOAD', p_payload_hash);
  END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, p_state = 'connected');
  UPDATE app.station_runtime_state
  SET connection_state = CASE WHEN p_state = 'connected' THEN 'connected' ELSE 'disconnected' END,
      last_connected_at = CASE WHEN p_state = 'connected' THEN p_csms_timestamp ELSE last_connected_at END,
      last_disconnected_at = CASE WHEN p_state = 'closed' THEN p_csms_timestamp ELSE last_disconnected_at END,
      updated_at = now()
  WHERE station_id = s.id
    AND (last_event_csms_at IS NULL OR p_csms_timestamp >= last_event_csms_at);
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'connection', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_heartbeat(
  p_station_ref text, p_event_ref text, p_csms_timestamp timestamptz,
  p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  UPDATE app.station_runtime_state
  SET last_heartbeat_at = p_csms_timestamp,
      connection_state = CASE WHEN connection_state = 'unknown' THEN 'connected' ELSE connection_state END,
      updated_at = now()
  WHERE station_id = s.id
    AND (last_heartbeat_at IS NULL OR p_csms_timestamp >= last_heartbeat_at);
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_status(
  p_station_ref text, p_connector_number integer, p_status text, p_error_code text,
  p_charger_timestamp timestamptz, p_event_ref text, p_csms_timestamp timestamptz,
  p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; c record;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  IF s.registration_status = 'decommissioned' THEN RETURN app.reject_ingest_event(p_station_ref, 'STATION_DECOMMISSIONED', p_payload_hash); END IF;
  IF p_status NOT IN ('Available','Preparing','Charging','SuspendedEV','SuspendedEVSE','Finishing','Reserved','Unavailable','Faulted') THEN
    RETURN app.reject_ingest_event(p_station_ref, 'MALFORMED_PAYLOAD', p_payload_hash);
  END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  IF p_connector_number = 0 THEN
    INSERT INTO app.station_status_events
      (tenant_id, site_id, station_id, connector_id, status, error_code, csms_event_ref, csms_timestamp, charger_reported_at)
    VALUES (s.tenant_id, s.site_id, s.id, NULL,
      CASE p_status WHEN 'Available' THEN 'available' WHEN 'Preparing' THEN 'preparing' WHEN 'Charging' THEN 'charging'
        WHEN 'SuspendedEV' THEN 'suspended_ev' WHEN 'SuspendedEVSE' THEN 'suspended_evse' WHEN 'Finishing' THEN 'finishing'
        WHEN 'Reserved' THEN 'reserved' WHEN 'Unavailable' THEN 'unavailable' ELSE 'faulted' END,
      left(p_error_code, 64), p_event_ref, p_csms_timestamp, p_charger_timestamp)
    ON CONFLICT (station_id, csms_event_ref, csms_timestamp) DO NOTHING;
    RETURN 'accepted';
  END IF;
  SELECT * INTO c FROM app.connectors WHERE station_id = s.id AND connector_number = p_connector_number;
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'MISSING_CONNECTOR', p_payload_hash); END IF;
  UPDATE app.connectors
  SET status = CASE p_status WHEN 'Available' THEN 'available' WHEN 'Preparing' THEN 'preparing' WHEN 'Charging' THEN 'charging'
        WHEN 'SuspendedEV' THEN 'suspended_ev' WHEN 'SuspendedEVSE' THEN 'suspended_evse' WHEN 'Finishing' THEN 'finishing'
        WHEN 'Reserved' THEN 'reserved' WHEN 'Unavailable' THEN 'unavailable' ELSE 'faulted' END,
      error_code = p_error_code, last_status_at = p_charger_timestamp, last_event_csms_at = p_csms_timestamp, updated_at = now()
  WHERE id = c.id AND (last_event_csms_at IS NULL OR p_csms_timestamp > last_event_csms_at);
  INSERT INTO app.station_status_events
    (tenant_id, site_id, station_id, connector_id, status, error_code, csms_event_ref, csms_timestamp, charger_reported_at)
  VALUES (s.tenant_id, s.site_id, s.id, c.id,
    CASE p_status WHEN 'Available' THEN 'available' WHEN 'Preparing' THEN 'preparing' WHEN 'Charging' THEN 'charging'
      WHEN 'SuspendedEV' THEN 'suspended_ev' WHEN 'SuspendedEVSE' THEN 'suspended_evse' WHEN 'Finishing' THEN 'finishing'
      WHEN 'Reserved' THEN 'reserved' WHEN 'Unavailable' THEN 'unavailable' ELSE 'faulted' END,
    left(p_error_code, 64), p_event_ref, p_csms_timestamp, p_charger_timestamp)
  ON CONFLICT (station_id, csms_event_ref, csms_timestamp) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_transaction_start(
  p_station_ref text, p_correlation_id text, p_connector_number integer, p_id_tag text,
  p_meter_start_wh bigint, p_charger_timestamp timestamptz, p_event_ref text,
  p_csms_timestamp timestamptz, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; c record; v_start timestamptz; v_source text;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  IF s.registration_status = 'decommissioned' THEN RETURN app.reject_ingest_event(p_station_ref, 'STATION_DECOMMISSIONED', p_payload_hash); END IF;
  SELECT * INTO c FROM app.connectors WHERE station_id = s.id AND connector_number = p_connector_number;
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'MISSING_CONNECTOR', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  IF p_charger_timestamp IS NOT NULL AND abs(extract(epoch FROM (p_charger_timestamp - p_csms_timestamp))) <= 86400 THEN
    v_start := p_charger_timestamp; v_source := 'charger';
  ELSE
    v_start := p_csms_timestamp; v_source := 'csms';
  END IF;
  INSERT INTO app.pending_transaction_starts
    (tenant_id, site_id, station_id, connector_id, csms_start_correlation_id, id_tag,
     meter_start_wh, started_at, started_at_source, charger_reported_at, csms_timestamp, expires_at)
  VALUES (s.tenant_id, s.site_id, s.id, c.id, p_correlation_id, left(p_id_tag, 64),
          p_meter_start_wh, v_start, v_source, p_charger_timestamp, p_csms_timestamp,
          now() + interval '5 minutes')
  ON CONFLICT (csms_start_correlation_id) DO NOTHING;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'start', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_transaction_start_response(
  p_station_ref text, p_correlation_id text, p_transaction_ref text, p_id_tag_status text,
  p_event_ref text, p_csms_timestamp timestamptz, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; p record; v_existing record; v_status text;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  IF EXISTS (
    SELECT 1 FROM app.sessions
    WHERE station_id = s.id AND csms_start_correlation_id = p_correlation_id
  ) THEN
    DELETE FROM app.pending_transaction_starts
    WHERE station_id = s.id AND csms_start_correlation_id = p_correlation_id;
    RETURN 'duplicate';
  END IF;
  SELECT * INTO p FROM app.pending_transaction_starts
  WHERE station_id = s.id AND csms_start_correlation_id = p_correlation_id;
  IF NOT FOUND THEN RETURN 'retry'; END IF;
  IF p_transaction_ref IS NULL THEN RETURN 'retry'; END IF;
  SELECT * INTO v_existing FROM app.sessions
  WHERE station_id = s.id AND csms_transaction_ref = p_transaction_ref;
  IF FOUND THEN
    DELETE FROM app.pending_transaction_starts WHERE id = p.id;
    RETURN 'duplicate';
  END IF;
  v_status := CASE WHEN p_id_tag_status = 'Accepted' THEN 'active' ELSE 'failed' END;
  IF v_status = 'active' THEN
    UPDATE app.sessions
    SET status = 'failed', stop_reason = 'superseded', ended_at = p.started_at,
        ended_at_source = 'csms', updated_at = now()
    WHERE connector_id = p.connector_id AND status IN ('starting', 'active');
  END IF;
  INSERT INTO app.sessions
    (tenant_id, site_id, station_id, connector_id, csms_transaction_ref, csms_start_correlation_id,
     id_tag, meter_start_wh, started_at, started_at_source, charger_started_at, ended_at,
     ended_at_source, energy_wh, status, stop_reason)
  VALUES (p.tenant_id, p.site_id, p.station_id, p.connector_id, p_transaction_ref, p_correlation_id,
          p.id_tag, p.meter_start_wh, p.started_at, p.started_at_source, p.charger_reported_at,
          CASE WHEN v_status = 'failed' THEN p.started_at ELSE NULL END,
          CASE WHEN v_status = 'failed' THEN 'csms' ELSE NULL END,
          0, v_status,
          CASE WHEN v_status = 'failed' THEN 'START_REJECTED' ELSE NULL END);
  DELETE FROM app.pending_transaction_starts WHERE id = p.id;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'start_response', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_meter_values(
  p_station_ref text, p_transaction_ref text, p_event_ref text, p_csms_timestamp timestamptz,
  p_samples jsonb, p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; sess record; sample jsonb; idx integer := 0; v_energy bigint; v_max_energy bigint; v_power integer;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  SELECT * INTO sess FROM app.sessions WHERE station_id = s.id AND csms_transaction_ref = p_transaction_ref;
  IF NOT FOUND THEN RETURN 'retry'; END IF;
  FOR sample IN SELECT * FROM jsonb_array_elements(COALESCE(p_samples, '[]'::jsonb)) LOOP
    idx := idx + 1;
    IF idx > 200 THEN RETURN app.record_parked_event(p_station_ref, p_event_ref, p_csms_timestamp, 'meter', 'SAMPLE_LIMIT', p_payload_hash); END IF;
    v_energy := NULLIF(sample->>'energy_wh','')::bigint;
    v_max_energy := greatest(v_max_energy, v_energy);
    v_power := NULLIF(sample->>'power_w','')::integer;
    INSERT INTO app.session_meter_values
      (tenant_id, site_id, station_id, session_id, csms_event_ref, csms_timestamp,
       charger_reported_at, energy_wh, power_w)
    SELECT sess.tenant_id, sess.site_id, sess.station_id, sess.id, p_event_ref || ':' || idx,
           p_csms_timestamp, NULLIF(sample->>'recorded_at','')::timestamptz, v_energy, v_power
    WHERE NOT EXISTS (
      SELECT 1 FROM app.session_meter_values m
      WHERE m.session_id = sess.id
        AND m.tenant_id = sess.tenant_id
        AND m.charger_reported_at = NULLIF(sample->>'recorded_at','')::timestamptz
    )
    ON CONFLICT (station_id, csms_event_ref, csms_timestamp) DO NOTHING;
  END LOOP;
  IF v_max_energy IS NOT NULL THEN
    UPDATE app.sessions
    SET energy_wh = greatest(energy_wh, greatest(0, v_max_energy - meter_start_wh)),
        updated_at = now()
    WHERE id = sess.id;
  END IF;
  RETURN 'accepted';
END
$fn$;

CREATE OR REPLACE FUNCTION app.ingest_transaction_stop(
  p_station_ref text, p_transaction_ref text, p_meter_stop_wh bigint, p_reason text,
  p_charger_timestamp timestamptz, p_event_ref text, p_csms_timestamp timestamptz,
  p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; sess record; v_end timestamptz; v_source text; v_energy bigint;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, true);
  SELECT * INTO sess FROM app.sessions WHERE station_id = s.id AND csms_transaction_ref = p_transaction_ref;
  IF NOT FOUND THEN RETURN 'retry'; END IF;
  IF sess.ended_at IS NOT NULL THEN RETURN 'duplicate'; END IF;
  IF p_charger_timestamp IS NOT NULL AND abs(extract(epoch FROM (p_charger_timestamp - p_csms_timestamp))) <= 86400 THEN
    v_end := p_charger_timestamp; v_source := 'charger';
  ELSE v_end := p_csms_timestamp; v_source := 'csms';
  END IF;
  v_energy := greatest(0, COALESCE(p_meter_stop_wh, 0) - sess.meter_start_wh);
  UPDATE app.sessions
  SET ended_at = v_end, ended_at_source = v_source, charger_ended_at = p_charger_timestamp,
      energy_wh = greatest(energy_wh, v_energy), status = 'completed', stop_reason = left(p_reason, 64),
      updated_at = now()
  WHERE id = sess.id;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'stop', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
  RETURN 'accepted';
END
$fn$;

-- Job functions
CREATE OR REPLACE FUNCTION app.expire_pending_starts(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  WITH expired AS (
    SELECT * FROM app.pending_transaction_starts
    WHERE expires_at <= now() ORDER BY expires_at LIMIT p_limit
  ), deleted AS (
    DELETE FROM app.pending_transaction_starts p USING expired e WHERE p.id=e.id RETURNING e.*
  ), ledger AS (
    INSERT INTO app.ingestion_events
      (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code)
    SELECT st.station_ref, d.tenant_id, d.site_id, 'start',
           'start-response-missing:' || d.csms_start_correlation_id,
           d.csms_timestamp, 'parked', 'START_RESPONSE_MISSING'
    FROM deleted d JOIN app.stations st ON st.id = d.station_id
    ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n FROM deleted;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.sweep_offline_stations(p_timeout_seconds integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  UPDATE app.station_runtime_state
  SET connection_state='disconnected', last_disconnected_at=now(), updated_at=now()
  WHERE connection_state='connected'
    AND last_seen_at < now() - make_interval(secs => p_timeout_seconds);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.close_stale_sessions(p_stale_seconds integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  UPDATE app.sessions s
  SET status='failed', stop_reason='STALE_SESSION_CLOSED', ended_at=now(), ended_at_source='csms', updated_at=now()
  WHERE s.status IN ('starting','active')
    AND NOT EXISTS (
      SELECT 1 FROM app.station_runtime_state r
      WHERE r.station_id = s.station_id AND r.connection_state = 'connected'
    )
    AND greatest(
      s.started_at,
      coalesce((SELECT max(m.csms_timestamp) FROM app.session_meter_values m WHERE m.session_id=s.id), s.started_at)
    ) < now() - make_interval(secs => p_stale_seconds);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.pseudonymize_session_id_tags(p_before timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  UPDATE app.sessions SET id_tag=NULL WHERE ended_at IS NOT NULL AND ended_at < p_before AND id_tag IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.prune_ingestion_rejections(p_days integer DEFAULT 30)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  DELETE FROM app.ingestion_rejections WHERE day < current_date - p_days;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.drop_expired_event_partitions(p_parent text, p_before date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE rel regclass; n integer := 0; month text;
BEGIN
  IF p_parent NOT IN ('session_meter_values','station_status_events','ingestion_events') THEN
    RAISE EXCEPTION 'unsupported event parent: %', p_parent;
  END IF;
  IF p_before IS NULL OR p_before <> date_trunc('month', p_before)::date THEN
    RAISE EXCEPTION 'p_before must be the first day of a month';
  END IF;
  FOR rel IN
    SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
    JOIN pg_inherits i ON i.inhrelid=c.oid JOIN pg_class p ON p.oid=i.inhparent
    WHERE ns.nspname='app' AND p.relname=p_parent
  LOOP
    month := substring(rel::text FROM '_([0-9]{4}_[0-9]{2})$');
    IF month IS NOT NULL AND (month || '-01')::date < p_before THEN
      EXECUTE format('DROP TABLE %s', rel); n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $fn$;

-- Meter dedup lookup index (non-unique; partitioned parents cannot enforce uniqueness without the partition key).
CREATE INDEX IF NOT EXISTS session_meter_values_session_charger_idx
  ON app.session_meter_values (session_id, charger_reported_at);

-- Column-level ingest-definer privileges (no INSERT on stations/connectors).
REVOKE ALL ON app.stations, app.station_runtime_state, app.connectors, app.sessions,
  app.session_meter_values, app.station_status_events, app.pending_transaction_starts,
  app.ingestion_events, app.ingestion_rejections, app.sites FROM evstation_ingest_definer;
GRANT SELECT ON app.stations TO evstation_ingest_definer;
GRANT UPDATE (reported_vendor, reported_model, reported_serial, reported_firmware, last_boot_at)
  ON app.stations TO evstation_ingest_definer;
GRANT SELECT, UPDATE (connection_state, last_heartbeat_at, last_connected_at,
  last_disconnected_at, last_event_csms_at, last_seen_at, updated_at)
  ON app.station_runtime_state TO evstation_ingest_definer;
GRANT SELECT, UPDATE (status, error_code, last_status_at, last_event_csms_at, updated_at)
  ON app.connectors TO evstation_ingest_definer;
GRANT SELECT ON app.sessions TO evstation_ingest_definer;
GRANT INSERT (tenant_id, site_id, station_id, connector_id, csms_transaction_ref,
  csms_start_correlation_id, id_tag, meter_start_wh, started_at, started_at_source,
  charger_started_at, ended_at, ended_at_source, energy_wh, status, stop_reason)
  ON app.sessions TO evstation_ingest_definer;
GRANT UPDATE (status, stop_reason, ended_at, ended_at_source, charger_ended_at,
  energy_wh, updated_at, id_tag) ON app.sessions TO evstation_ingest_definer;
GRANT SELECT ON app.session_meter_values TO evstation_ingest_definer;
GRANT INSERT (tenant_id, site_id, station_id, session_id, csms_event_ref, csms_timestamp,
  charger_reported_at, energy_wh, power_w) ON app.session_meter_values TO evstation_ingest_definer;
GRANT SELECT ON app.station_status_events TO evstation_ingest_definer;
GRANT INSERT (tenant_id, site_id, station_id, connector_id, status, error_code,
  csms_event_ref, csms_timestamp, charger_reported_at) ON app.station_status_events TO evstation_ingest_definer;
GRANT SELECT, DELETE ON app.pending_transaction_starts TO evstation_ingest_definer;
GRANT INSERT (tenant_id, site_id, station_id, connector_id, csms_start_correlation_id,
  id_tag, meter_start_wh, started_at, started_at_source, charger_reported_at, csms_timestamp, expires_at)
  ON app.pending_transaction_starts TO evstation_ingest_definer;
GRANT SELECT ON app.ingestion_events TO evstation_ingest_definer;
GRANT INSERT (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp,
  outcome, reason_code, payload_hash) ON app.ingestion_events TO evstation_ingest_definer;
GRANT SELECT ON app.ingestion_rejections TO evstation_ingest_definer;
GRANT INSERT (station_ref, reason_code, day, occurrence_count, first_seen_at, last_seen_at)
  ON app.ingestion_rejections TO evstation_ingest_definer;
GRANT UPDATE (occurrence_count, last_seen_at) ON app.ingestion_rejections TO evstation_ingest_definer;
GRANT DELETE ON app.ingestion_rejections TO evstation_ingest_definer;
GRANT SELECT ON app.sites TO evstation_ingest_definer;

-- App connector insert is column-level; table-level INSERT is intentionally absent.
REVOKE ALL ON app.connectors FROM evstation_app;
GRANT SELECT ON app.connectors TO evstation_app;
GRANT INSERT (tenant_id, site_id, station_id, connector_number, type, max_power_w)
  ON app.connectors TO evstation_app;

-- Platform-admin-only rejection read path.
GRANT SELECT ON app.ingestion_rejections TO evstation_app;
DROP POLICY IF EXISTS ingestion_rejections_platform_select ON app.ingestion_rejections;
CREATE POLICY ingestion_rejections_platform_select ON app.ingestion_rejections
  FOR SELECT TO evstation_app
  USING ((SELECT app.is_platform_admin()));

-- Ownership for new/changed functions.
ALTER FUNCTION app.touch_station_liveness(uuid, timestamptz, boolean) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.expire_pending_starts(integer) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.sweep_offline_stations(integer) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.close_stale_sessions(integer) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.pseudonymize_session_id_tags(timestamptz) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.prune_ingestion_rejections(integer) OWNER TO evstation_ingest_definer;
ALTER FUNCTION app.drop_expired_event_partitions(text, date) OWNER TO evstation_event_owner;
REVOKE ALL ON FUNCTION app.touch_station_liveness(uuid, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prune_ingestion_rejections(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_ingestion_rejections(integer) TO evstation_jobs;
