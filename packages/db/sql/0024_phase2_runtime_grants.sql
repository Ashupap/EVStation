-- 0024_phase2_runtime_grants.sql — ON CONFLICT needs SELECT on the conflict
-- target for the definer-owned runtime-state trigger.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;
GRANT SELECT ON app.station_runtime_state TO evstation_definer;
RESET ROLE;
