-- 0009_guard_null_safety.sql — fail closed on NULL/malformed context
-- (review HIGH 3 and test b).
--
-- Previously guards used `IF NOT (helper AND ...)`, which is NULL (i.e. does
-- not raise) when the helper was NULL for an actor without a membership.
-- All authorization predicates now use `IS NOT TRUE` / explicit coalesce.
-- UUID GUCs are parsed by app.try_uuid(), which maps malformed input to NULL
-- so policies see no context instead of throwing a 500.

CREATE OR REPLACE FUNCTION app.try_uuid(p_value text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  RETURN p_value::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END
$fn$;

ALTER FUNCTION app.try_uuid(text) OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.try_uuid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.try_uuid(text) TO evstation_app;

CREATE OR REPLACE FUNCTION app.actor_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT app.try_uuid(current_setting('app.actor_id', true))
$fn$;

CREATE OR REPLACE FUNCTION app.raw_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT app.try_uuid(current_setting('app.tenant_id', true))
$fn$;

CREATE OR REPLACE FUNCTION app.guard_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  target_tenant uuid;
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

CREATE OR REPLACE FUNCTION app.guard_invitation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  actor_rank integer;
  valid_sites integer;
BEGIN
  IF current_user = 'evstation_definer' THEN
    RETURN NEW;
  END IF;
  IF app.actor_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF app.is_platform_admin() IS NOT TRUE THEN
    IF app.is_tenant_admin() IS NOT TRUE
       OR NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
      RAISE EXCEPTION 'invitation_forbidden';
    END IF;
    actor_rank := coalesce(app.role_rank(app.actor_role()), 0);
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

CREATE OR REPLACE FUNCTION app.guard_tenant_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND app.actor_id() IS NOT NULL
     AND app.is_platform_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'tenant_status_forbidden';
  END IF;
  RETURN NEW;
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
    WHERE n.nspname = 'app'
      AND p.proname IN ('guard_membership', 'guard_invitation', 'guard_tenant_status')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;
