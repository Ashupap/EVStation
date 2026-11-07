-- 0007_accept_invitation_context.sql — trusted definer context (review HIGH 1)
--
-- accept_invitation runs as evstation_definer and may be called while the API
-- has set app.actor_id to the invitee (for audit). The invitee is not yet a
-- member, so actor-based guards would reject the membership insert.
--
-- The guard triggers become SECURITY INVOKER and skip actor checks *only*
-- when current_user is evstation_definer. The app role cannot SET ROLE to
-- the definer (no membership, NOLOGIN), so this marker cannot be forged; the
-- definer function itself validates token/email/role/site scope (0006/0012).

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

ALTER FUNCTION app.guard_membership() OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.guard_membership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.guard_membership() TO evstation_app;
