-- 0011_targeted_site_manager_scope.sql — check only the affected membership
-- (review HIGH 5).
--
-- The deferred constraint trigger used to scan every membership and raise if
-- any site_manager anywhere lacked a site. That made writes in one tenant fail
-- because of unrelated (including legacy) data in another. Scope the probe to
-- the membership the trigger fired for; the composite FKs already guarantee
-- that assigned sites belong to the same tenant.

CREATE OR REPLACE FUNCTION app.check_site_manager_scope()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  target_membership uuid;
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    target_membership := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_membership :=
      CASE WHEN TG_OP = 'DELETE' THEN OLD.membership_id ELSE NEW.membership_id END;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app.memberships m
    WHERE m.id = target_membership
      AND m.role = 'site_manager'
      AND NOT EXISTS (
        SELECT 1 FROM app.membership_sites ms WHERE ms.membership_id = m.id
      )
  ) THEN
    RAISE EXCEPTION 'site_manager_requires_site';
  END IF;
  RETURN NULL;
END
$fn$;

DO $own$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'check_site_manager_scope'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;
