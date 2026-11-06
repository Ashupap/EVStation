-- 0016_null_verified_and_tenant_mismatch.sql — final round-2 NULL-safety
-- fixes.
--
-- * accept_invitation used `IF NOT p_email_verified`, so a NULL parameter
--   skipped verification entirely. Require the value to be TRUE.
-- * guard_membership compared NEW.tenant_id with `<>`, which is NULL (no
--   error) when app.tenant_id() is NULL. Use IS DISTINCT FROM.

CREATE OR REPLACE FUNCTION app.accept_invitation(
  p_token_hash    text,
  p_user_id       uuid,
  p_email         text,
  p_email_verified boolean,
  p_external_id   text DEFAULT NULL
)
RETURNS TABLE (tenant_id uuid, membership_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  inv app.invitations%ROWTYPE;
  tenant_status text;
  site_count integer;
  inserted_sites integer;
  inviter_role text;
  inviter_is_platform boolean;
BEGIN
  IF p_email_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'email_not_verified';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invitation_invalid';
  END IF;
  IF p_user_id IS NULL OR p_email IS NULL THEN
    RAISE EXCEPTION 'invitation_invalid';
  END IF;

  SELECT * INTO inv
  FROM app.invitations i
  WHERE i.token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND
     OR inv.accepted_at IS NOT NULL
     OR inv.revoked_at IS NOT NULL
     OR inv.expires_at <= now()
     OR lower(btrim(p_email)) <> lower(inv.email) THEN
    RAISE EXCEPTION 'invitation_invalid';
  END IF;

  SELECT t.status INTO tenant_status FROM app.tenants t WHERE t.id = inv.tenant_id;
  IF tenant_status <> 'active' THEN
    RAISE EXCEPTION 'tenant_suspended';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM app.platform_admins pa WHERE pa.user_id = inv.invited_by),
    (SELECT m.role FROM app.memberships m
     WHERE m.user_id = inv.invited_by AND m.tenant_id = inv.tenant_id)
  INTO inviter_is_platform, inviter_role;

  IF inviter_is_platform IS NOT TRUE
     AND (
       inviter_role IS NULL
       OR inviter_role <> 'tenant_admin'
       OR app.role_rank(inv.role) > app.role_rank(inviter_role)
     ) THEN
    RAISE EXCEPTION 'inviter_not_authorized';
  END IF;

  BEGIN
    INSERT INTO app.users (id, email, email_verified, external_id)
    VALUES (p_user_id, lower(btrim(p_email)), true, p_external_id)
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          email_verified = true,
          external_id = coalesce(app.users.external_id, EXCLUDED.external_id)
      WHERE lower(app.users.email) = lower(EXCLUDED.email);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'email_mismatch';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'email_in_use';
  END;

  IF EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.user_id = p_user_id AND m.tenant_id = inv.tenant_id
  ) THEN
    RAISE EXCEPTION 'already_member';
  END IF;

  IF inv.role = 'site_manager' AND coalesce(array_length(inv.site_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'site_required';
  END IF;

  INSERT INTO app.memberships (tenant_id, user_id, role)
  VALUES (inv.tenant_id, p_user_id, inv.role)
  RETURNING id INTO membership_id;

  IF inv.role = 'site_manager' THEN
    WITH inserted AS (
      INSERT INTO app.membership_sites (membership_id, site_id, tenant_id)
      SELECT membership_id, s.id, inv.tenant_id
      FROM unnest(inv.site_ids) AS wanted(id)
      JOIN app.sites s ON s.id = wanted.id AND s.tenant_id = inv.tenant_id
      RETURNING 1
    )
    SELECT count(*) INTO inserted_sites FROM inserted;

    site_count := coalesce(array_length(inv.site_ids, 1), 0);
    IF inserted_sites <> site_count THEN
      RAISE EXCEPTION 'invalid_site_scope';
    END IF;
  END IF;

  UPDATE app.invitations
  SET accepted_at = now(), accepted_by = p_user_id
  WHERE id = inv.id;

  INSERT INTO app.audit_log
    (tenant_id, actor_id, action, resource_type, resource_id, outcome, details)
  VALUES (
    inv.tenant_id,
    p_user_id,
    'invitation.accepted',
    'invitation',
    inv.id::text,
    'allowed',
    jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by)
  );

  tenant_id := inv.tenant_id;
  role := inv.role;
  RETURN NEXT;
END
$fn$;

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

  IF TG_OP = 'INSERT' AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
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


ALTER FUNCTION app.accept_invitation(text, uuid, text, boolean, text)
  OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.accept_invitation(text, uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text, uuid, text, boolean, text)
  TO evstation_app;

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

-- RI cascades (e.g. deleting a user) execute table triggers with the table
-- owner as current_user. Let the trusted owner call the read-only context
-- helpers so those cascades still reach the append-only guard instead of
-- failing on an unrelated function privilege.
DO $owner_helpers$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname IN (
        'actor_id', 'raw_tenant_id', 'tenant_id', 'is_platform_admin',
        'is_tenant_admin', 'actor_role', 'role_rank', 'try_uuid'
      )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_owner', fn);
  END LOOP;
END
$owner_helpers$;

-- Future functions created by the migration/superuser role also start closed.
-- The schema-scoped statement is kept as documentation: PostgreSQL coalesces
-- it into the global default ACL for this role, so pg_default_acl stores only
-- the global row.
ALTER DEFAULT PRIVILEGES FOR ROLE evstation
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE evstation IN SCHEMA app
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
