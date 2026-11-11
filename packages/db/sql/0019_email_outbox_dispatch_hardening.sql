-- 0019_email_outbox_dispatch_hardening.sql — retryable, token-scrubbing outbox.
--
-- Dispatch rows stay pending until the mailer succeeds. The bearer token is
-- part of accept_url, so it is cleared as soon as delivery is recorded (or
-- when a row expires / exhausts its retries). The API role never receives
-- SELECT on accept_url; only the definer-owned worker functions return it.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

ALTER TABLE app.email_outbox ALTER COLUMN accept_url DROP NOT NULL;
ALTER TABLE app.email_outbox
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN claimed_at timestamptz;

DROP INDEX app.email_outbox_pending_idx;
CREATE INDEX email_outbox_pending_idx
  ON app.email_outbox (next_attempt_at, created_at, id) WHERE dispatched_at IS NULL;

GRANT SELECT, UPDATE, DELETE ON app.email_outbox TO evstation_definer;
REVOKE SELECT ON app.email_outbox FROM evstation_app;
GRANT SELECT (
  id,
  tenant_id,
  invitation_id,
  recipient,
  expires_at,
  created_at,
  dispatched_at,
  last_error,
  attempts,
  next_attempt_at,
  claimed_at
) ON app.email_outbox TO evstation_app;

RESET ROLE;
SET search_path = pg_catalog, app, pg_temp;

CREATE OR REPLACE FUNCTION app.claim_email_outbox(p_limit integer DEFAULT 10)
RETURNS SETOF app.email_outbox
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  WITH picked AS (
    SELECT o.id
    FROM app.email_outbox o
    WHERE o.dispatched_at IS NULL
      AND o.accept_url IS NOT NULL
      AND o.expires_at > now()
      AND o.next_attempt_at <= now()
    ORDER BY o.next_attempt_at, o.created_at, o.id
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(0, least(p_limit, 100))
  )
  UPDATE app.email_outbox o
  SET attempts = o.attempts + 1,
      claimed_at = now(),
      next_attempt_at = now() + interval '5 minutes'
  FROM picked
  WHERE o.id = picked.id
  RETURNING o.*;
$fn$;

CREATE OR REPLACE FUNCTION app.claim_email_outbox_for_id(p_id uuid)
RETURNS SETOF app.email_outbox
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  UPDATE app.email_outbox o
  SET attempts = o.attempts + 1,
      claimed_at = now(),
      next_attempt_at = now() + interval '5 minutes'
  WHERE o.id = p_id
    AND o.dispatched_at IS NULL
    AND o.accept_url IS NOT NULL
    AND o.expires_at > now()
    AND o.next_attempt_at <= now()
  RETURNING o.*;
$fn$;

CREATE OR REPLACE FUNCTION app.complete_email_outbox(p_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  UPDATE app.email_outbox
  SET dispatched_at = now(),
      accept_url = NULL,
      last_error = NULL,
      claimed_at = NULL
  WHERE id = p_id;
$fn$;

CREATE OR REPLACE FUNCTION app.fail_email_outbox(
  p_id uuid,
  p_error text,
  p_max_attempts integer DEFAULT 5
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  UPDATE app.email_outbox
  SET claimed_at = NULL,
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'delivery failed'), 200),
      accept_url = CASE
        WHEN attempts >= greatest(1, p_max_attempts) OR expires_at <= now() THEN NULL
        ELSE accept_url
      END,
      next_attempt_at = CASE
        WHEN attempts >= greatest(1, p_max_attempts) OR expires_at <= now()
          THEN 'infinity'::timestamptz
        ELSE now() + make_interval(secs => least(3600, 30 * power(2, attempts)))
      END
  WHERE id = p_id AND dispatched_at IS NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION app.prune_email_outbox(p_retention_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  scrubbed integer;
  deleted integer;
BEGIN
  UPDATE app.email_outbox
  SET accept_url = NULL,
      claimed_at = NULL,
      last_error = coalesce(last_error, 'expired')
  WHERE dispatched_at IS NULL
    AND expires_at <= now()
    AND accept_url IS NOT NULL;
  GET DIAGNOSTICS scrubbed = ROW_COUNT;

  DELETE FROM app.email_outbox
  WHERE (dispatched_at IS NOT NULL
         AND dispatched_at < now() - make_interval(days => greatest(0, p_retention_days)))
     OR (dispatched_at IS NULL
         AND expires_at < now() - make_interval(days => greatest(0, p_retention_days))
         AND accept_url IS NULL);
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RETURN scrubbed + deleted;
END
$fn$;

ALTER FUNCTION app.claim_email_outbox(integer) OWNER TO evstation_definer;
ALTER FUNCTION app.claim_email_outbox_for_id(uuid) OWNER TO evstation_definer;
ALTER FUNCTION app.complete_email_outbox(uuid) OWNER TO evstation_definer;
ALTER FUNCTION app.fail_email_outbox(uuid, text, integer) OWNER TO evstation_definer;
ALTER FUNCTION app.prune_email_outbox(integer) OWNER TO evstation_definer;

REVOKE ALL ON FUNCTION app.claim_email_outbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_email_outbox_for_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_email_outbox(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_email_outbox(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prune_email_outbox(integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.claim_email_outbox(integer) TO evstation_app;
GRANT EXECUTE ON FUNCTION app.claim_email_outbox_for_id(uuid) TO evstation_app;
GRANT EXECUTE ON FUNCTION app.complete_email_outbox(uuid) TO evstation_app;
GRANT EXECUTE ON FUNCTION app.fail_email_outbox(uuid, text, integer) TO evstation_app;
GRANT EXECUTE ON FUNCTION app.prune_email_outbox(integer) TO evstation_app;

RESET ROLE;
