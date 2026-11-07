-- 0012_invitation_hardening.sql — close invitation write/acceptance gaps
-- (review MEDIUM 6).
--
-- 1. evstation_app had table-level UPDATE on invitations, so a tenant admin
--    could rewrite role/site_ids/token_hash/expiry after the insert-time guard
--    and then accept an escalated invitation. Restrict app to the columns a
--    management UI needs: create the invitation, or revoke it.
-- 2. accept_invitation trusted the inviter forever. Re-check at acceptance
--    that the inviter is still a platform admin or a tenant_admin of the
--    target tenant and may still grant the invited role.
-- 3. Acceptance is a privileged mutation; write an append-only audit row.

REVOKE INSERT, UPDATE ON app.invitations FROM evstation_app;
GRANT INSERT (tenant_id, email, role, site_ids, invited_by, token_hash, expires_at)
  ON app.invitations TO evstation_app;
GRANT UPDATE (revoked_at) ON app.invitations TO evstation_app;

GRANT INSERT ON app.audit_log TO evstation_definer;
GRANT UPDATE ON app.invitations TO evstation_definer;

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
  IF NOT p_email_verified THEN
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

ALTER FUNCTION app.accept_invitation(text, uuid, text, boolean, text)
  OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.accept_invitation(text, uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text, uuid, text, boolean, text)
  TO evstation_app;
