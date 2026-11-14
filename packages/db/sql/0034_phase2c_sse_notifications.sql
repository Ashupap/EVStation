-- 0034_phase2c_sse_notifications.sql — additive phase 2c NOTIFY emission.
-- Existing functions remain SECURITY DEFINER and keep their 0032 owner.
CREATE OR REPLACE FUNCTION app.notify_event(
  p_kind text, p_tenant_id uuid, p_site_id uuid, p_station_id uuid,
  p_session_id uuid, p_occurred_at timestamptz,
  p_connector_id uuid DEFAULT NULL, p_event_id uuid DEFAULT gen_random_uuid()
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT pg_notify('evstation_events', jsonb_build_object(
    'v', 1, 'id', p_event_id, 'kind', p_kind,
    'tenant_id', p_tenant_id, 'site_id', p_site_id,
    'station_id', p_station_id, 'session_id', p_session_id,
    'connector_id', p_connector_id, 'occurred_at', p_occurred_at
  )::text)
$fn$;
ALTER FUNCTION app.notify_event(text,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid)
  OWNER TO evstation_ingest_definer;
REVOKE ALL ON FUNCTION app.notify_event(text,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC;

ALTER TABLE app.sessions ADD COLUMN IF NOT EXISTS last_meter_notify_at timestamptz;
GRANT UPDATE (last_meter_notify_at) ON app.sessions TO evstation_ingest_definer;

CREATE OR REPLACE FUNCTION app.ingest_connection(
  p_station_ref text, p_state text, p_event_ref text, p_csms_timestamp timestamptz,
  p_payload_hash text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE s record; v_prev text;
BEGIN
  SELECT * INTO s FROM app.ingest_station(p_station_ref);
  IF NOT FOUND THEN RETURN app.reject_ingest_event(p_station_ref, 'UNKNOWN_STATION', p_payload_hash); END IF;
  IF s.registration_status = 'decommissioned' THEN RETURN app.reject_ingest_event(p_station_ref, 'STATION_DECOMMISSIONED', p_payload_hash); END IF;
  IF p_state NOT IN ('connected', 'closed') THEN
    RETURN app.reject_ingest_event(p_station_ref, 'MALFORMED_PAYLOAD', p_payload_hash);
  END IF;
  SELECT connection_state INTO v_prev FROM app.station_runtime_state WHERE station_id = s.id;
  PERFORM app.touch_station_liveness(s.id, p_csms_timestamp, p_state = 'connected');
  UPDATE app.station_runtime_state
  SET connection_state = CASE WHEN p_state = 'connected' THEN 'connected' ELSE 'disconnected' END,
      last_connected_at = CASE WHEN p_state = 'connected' THEN p_csms_timestamp ELSE last_connected_at END,
      last_disconnected_at = CASE WHEN p_state = 'closed' THEN p_csms_timestamp ELSE last_disconnected_at END,
      updated_at = now()
  WHERE station_id = s.id
    AND (last_event_csms_at IS NULL OR p_csms_timestamp >= last_event_csms_at);
  IF v_prev IS DISTINCT FROM (CASE WHEN p_state = 'connected' THEN 'connected' ELSE 'disconnected' END) AND FOUND THEN
    PERFORM app.notify_event('station.connection', s.tenant_id, s.site_id, s.id, NULL, p_csms_timestamp);
  END IF;
  INSERT INTO app.ingestion_events
    (station_ref, tenant_id, site_id, kind, csms_event_ref, csms_timestamp, outcome, reason_code, payload_hash)
  VALUES (p_station_ref, s.tenant_id, s.site_id, 'connection', p_event_ref, p_csms_timestamp, 'accepted', NULL, p_payload_hash)
  ON CONFLICT (station_ref, csms_event_ref, csms_timestamp, outcome) DO NOTHING;
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
    IF FOUND THEN
      PERFORM app.notify_event('station.status', s.tenant_id, s.site_id, s.id, NULL,
        p_csms_timestamp, NULL);
    END IF;
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
  IF FOUND THEN
    PERFORM app.notify_event('station.status', s.tenant_id, s.site_id, s.id, NULL,
      p_csms_timestamp, c.id);
  END IF;
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
DECLARE s record; p record; v_existing record; v_status text; v_new_id uuid; v_old_id uuid;
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
    FOR v_old_id IN
      UPDATE app.sessions
      SET status = 'failed', stop_reason = 'superseded', ended_at = p.started_at,
          ended_at_source = 'csms', updated_at = now()
      WHERE connector_id = p.connector_id AND status IN ('starting', 'active')
      RETURNING id
    LOOP
      PERFORM app.notify_event('session.updated', p.tenant_id, p.site_id, p.station_id,
        v_old_id, p_csms_timestamp);
    END LOOP;
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
          CASE WHEN v_status = 'failed' THEN 'START_REJECTED' ELSE NULL END)
  RETURNING id INTO v_new_id;
  PERFORM app.notify_event(
    CASE WHEN v_status = 'active' THEN 'session.started' ELSE 'session.updated' END,
    p.tenant_id, p.site_id, p.station_id, v_new_id, p_csms_timestamp);
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
DECLARE s record; sess record; sample jsonb; idx integer := 0; v_energy bigint; v_max_energy bigint; v_power integer; v_should_notify boolean := false;
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
    v_should_notify :=
      (sess.last_meter_notify_at IS NULL OR
       sess.last_meter_notify_at <= p_csms_timestamp - make_interval(secs => coalesce(nullif(current_setting('evstation.meter_notify_interval_s', true), '')::int, 5)))
      AND greatest(sess.energy_wh, greatest(0, v_max_energy - sess.meter_start_wh)) IS DISTINCT FROM sess.energy_wh;
    UPDATE app.sessions
    SET energy_wh = greatest(energy_wh, greatest(0, v_max_energy - meter_start_wh)),
        last_meter_notify_at = CASE WHEN v_should_notify THEN p_csms_timestamp ELSE last_meter_notify_at END,
        updated_at = now()
    WHERE id = sess.id;
    IF v_should_notify THEN
      PERFORM app.notify_event('session.meter', sess.tenant_id, sess.site_id,
        sess.station_id, sess.id, p_csms_timestamp);
    END IF;
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
  PERFORM app.notify_event('session.ended', sess.tenant_id, sess.site_id,
    sess.station_id, sess.id, p_csms_timestamp);
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
  WITH offlined AS (
    UPDATE app.station_runtime_state
    SET connection_state='disconnected', last_disconnected_at=now(), updated_at=now()
    WHERE connection_state='connected'
      AND last_seen_at < now() - make_interval(secs => p_timeout_seconds)
    RETURNING tenant_id, site_id, station_id, updated_at
  )
  SELECT count(*) INTO n FROM (
    SELECT app.notify_event('station.connection', tenant_id, site_id, station_id, NULL, updated_at)
    FROM offlined
  ) notified;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION app.close_stale_sessions(p_stale_seconds integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp AS $fn$
DECLARE n integer;
BEGIN
  WITH closed AS (
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
      ) < now() - make_interval(secs => p_stale_seconds)
    RETURNING tenant_id, site_id, station_id, id, updated_at
  )
  SELECT count(*) INTO n FROM (
    SELECT app.notify_event('session.ended', tenant_id, site_id, station_id, id, updated_at)
    FROM closed
  ) notified;
  RETURN n;
END $fn$;

