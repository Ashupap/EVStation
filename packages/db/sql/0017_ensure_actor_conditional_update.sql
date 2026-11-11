-- 0017_ensure_actor_conditional_update.sql — keep first-login sync idempotent
--
-- 0008 is immutable once applied. This migration replaces app.ensure_actor so
-- an unchanged verified identity does not rewrite the row (and therefore does
-- not bump xmin/updated_at) on every request. Email and verification changes
-- still sync.

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
          external_id = coalesce(app.users.external_id, EXCLUDED.external_id)
      WHERE app.users.email IS DISTINCT FROM EXCLUDED.email
         OR app.users.email_verified IS DISTINCT FROM EXCLUDED.email_verified;
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
