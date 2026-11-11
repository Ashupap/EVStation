-- 0005_guards.sql — data-integrity and privilege-escalation guards.
--
-- These triggers run in addition to RLS. They are the database backstop for
-- the API's authorize() rules: they cannot grant access, only refuse writes
-- that the API should already have refused.

SET search_path = pg_catalog, app, pg_temp;

CREATE OR REPLACE FUNCTION app.guard_membership()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  target_tenant uuid;
BEGIN
  IF app.actor_id() IS NULL THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_tenant := OLD.tenant_id;
  ELSE
    target_tenant := NEW.tenant_id;
  END IF;

  IF NOT app.is_platform_admin() THEN
    IF NOT (app.is_tenant_admin() AND app.tenant_id() = target_tenant) THEN
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
    IF NOT EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.tenant_id = OLD.tenant_id
        AND m.role = 'tenant_admin'
        AND m.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'last_tenant_admin';
    END IF;
  END IF;

  RETURN coalesce(NEW, OLD);
END
$fn$;

CREATE OR REPLACE FUNCTION app.check_site_manager_scope()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.role = 'site_manager'
      AND NOT EXISTS (
        SELECT 1 FROM app.membership_sites ms WHERE ms.membership_id = m.id
      )
  ) THEN
    RAISE EXCEPTION 'site_manager_requires_site';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION app.guard_tenant_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND app.actor_id() IS NOT NULL
     AND NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'tenant_status_forbidden';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION app.guard_user_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND app.actor_id() IS NOT NULL THEN
    RAISE EXCEPTION 'email_change_forbidden';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION app.guard_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$fn$;

CREATE OR REPLACE FUNCTION app.guard_invitation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  actor_rank integer;
  valid_sites integer;
BEGIN
  IF app.actor_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT app.is_platform_admin() THEN
    IF NOT (app.is_tenant_admin() AND NEW.tenant_id = app.tenant_id()) THEN
      RAISE EXCEPTION 'invitation_forbidden';
    END IF;
    actor_rank := app.role_rank(app.actor_role());
    IF app.role_rank(NEW.role) > actor_rank THEN
      RAISE EXCEPTION 'role_above_actor';
    END IF;
  END IF;

  NEW.email := lower(btrim(NEW.email));
  NEW.invited_by := app.actor_id();
  IF NEW.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_expiry_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.tenants t WHERE t.id = NEW.tenant_id AND t.status = 'active'
  ) THEN
    RAISE EXCEPTION 'tenant_suspended';
  END IF;

  IF NEW.role = 'site_manager' THEN
    IF coalesce(array_length(NEW.site_ids, 1), 0) = 0 THEN
      RAISE EXCEPTION 'site_required';
    END IF;
    SELECT count(*) INTO valid_sites
    FROM app.sites s
    WHERE s.tenant_id = NEW.tenant_id AND s.id = ANY (NEW.site_ids);
    IF valid_sites <> array_length(NEW.site_ids, 1) THEN
      RAISE EXCEPTION 'invalid_site_scope';
    END IF;
  ELSIF coalesce(array_length(NEW.site_ids, 1), 0) <> 0 THEN
    RAISE EXCEPTION 'site_scope_not_allowed';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER memberships_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.guard_membership();

CREATE CONSTRAINT TRIGGER memberships_site_scope
  AFTER INSERT OR UPDATE OR DELETE ON app.memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_site_manager_scope();

CREATE CONSTRAINT TRIGGER membership_sites_site_scope
  AFTER INSERT OR UPDATE OR DELETE ON app.membership_sites
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_site_manager_scope();

CREATE TRIGGER tenants_guard_status
  BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_status();

CREATE TRIGGER users_guard_identity
  BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.guard_user_identity();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.guard_audit_append_only();

CREATE TRIGGER invitations_guard
  BEFORE INSERT ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.guard_invitation();

DO $own$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname IN (
        'guard_membership', 'check_site_manager_scope', 'guard_tenant_status',
        'guard_user_identity', 'guard_audit_append_only', 'guard_invitation'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;
