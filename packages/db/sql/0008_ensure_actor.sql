-- 0008_ensure_actor.sql — first-login user sync (review HIGH 2)
--
-- The app role has no INSERT/UPDATE privilege on app.users. The API sets
-- app.actor_id from the verified Keycloak `sub`, then calls this narrow
-- definer function. It can only touch the row whose id equals the caller's
-- own actor id, only with verified claims, and it is the only path allowed to
-- sync a verified email change (guard_user_identity skips definer context).

CREATE OR REPLACE FUNCTION app.guard_user_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF current_user = 'evstation_definer' THEN
    RETURN NEW;
  END IF;
  IF app.actor_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email_change_forbidden';
  END IF;
  RETURN NEW;
END
$fn$;

ALTER FUNCTION app.guard_user_identity() OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.guard_user_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.guard_user_identity() TO evstation_app;

CREATE OR REPLACE FUNCTION app.ensure_actor(
  p_user_id        uuid,
  p_email          text,
  p_email_verified boolean,
  p_external_id    text DEFAULT NULL
)
RETURNS SETOF app.users
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  v_email text;
BEGIN
  IF p_user_id IS NULL OR app.actor_id() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'actor_mismatch';
  END IF;
  IF p_email_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'email_not_verified';
  END IF;

  v_email := lower(btrim(coalesce(p_email, '')));
  IF position('@' IN v_email) <= 1 OR length(v_email) > 320 THEN
    RAISE EXCEPTION 'email_invalid';
  END IF;

  BEGIN
    INSERT INTO app.users (id, email, email_verified, external_id)
    VALUES (p_user_id, v_email, true, p_external_id)
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          email_verified = true,
          external_id = coalesce(app.users.external_id, EXCLUDED.external_id);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'email_in_use';
  END;

  RETURN QUERY SELECT u.* FROM app.users u WHERE u.id = p_user_id;
END
$fn$;

ALTER FUNCTION app.ensure_actor(uuid, text, boolean, text) OWNER TO evstation_definer;
REVOKE ALL ON FUNCTION app.ensure_actor(uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_actor(uuid, text, boolean, text) TO evstation_app;
