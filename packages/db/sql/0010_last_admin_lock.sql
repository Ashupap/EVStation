-- 0010_last_admin_lock.sql — serialize tenant membership changes so the
-- last-admin count cannot race (review HIGH 4).
--
-- Two admins demoting each other concurrently used to both observe two admins
-- and commit, leaving the tenant with zero. Every UPDATE/DELETE takes a
-- transaction-scoped advisory lock for the tenant BEFORE authority checks and
-- the remaining-admin count, so the second transaction sees the first commit.

CREATE OR REPLACE FUNCTION app.guard_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  target_tenant uuid;
  remaining_admins integer;
BEGIN
  IF current_user = 'evstation_definer' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF app.actor_id() IS NULL THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
  ELSE
    target_tenant := NEW.tenant_id;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('evstation:last_admin:' || target_tenant::text, 0)
    );
  END IF;

  IF app.is_platform_admin() IS NOT TRUE THEN
    IF app.is_tenant_admin() IS NOT TRUE
       OR app.tenant_id() IS DISTINCT FROM target_tenant THEN
      RAISE EXCEPTION 'membership_change_forbidden';
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE')
       AND app.role_rank(NEW.role) > app.role_rank(app.actor_role()) THEN
      RAISE EXCEPTION 'role_above_actor';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.tenant_id <> app.tenant_id() THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION 'membership_keys_immutable';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.role = 'tenant_admin'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'tenant_admin') THEN
    WITH remaining AS (
      SELECT m.id
      FROM app.memberships m
      WHERE m.tenant_id = OLD.tenant_id
        AND m.role = 'tenant_admin'
        AND m.id <> OLD.id
      FOR UPDATE
    )
    SELECT count(*) INTO remaining_admins FROM remaining;
    IF remaining_admins = 0 THEN
      RAISE EXCEPTION 'last_tenant_admin';
    END IF;
  END IF;

  RETURN coalesce(NEW, OLD);
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
    WHERE n.nspname = 'app' AND p.proname = 'guard_membership'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;
