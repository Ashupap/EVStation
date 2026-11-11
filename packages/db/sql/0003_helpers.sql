-- 0003_helpers.sql — context/scope helpers (ADR-0011).
--
-- All helper functions are SECURITY DEFINER, owned by evstation_definer
-- (BYPASSRLS) and pinned to a safe search_path. They are the ONLY functions
-- the app role may execute besides app.accept_invitation.
--
-- The app sets exactly two GUCs per transaction: app.actor_id, app.tenant_id.
-- Everything else (platform admin, membership role, site scope, suspension)
-- is derived here from the database.

SET search_path = pg_catalog, app, pg_temp;

CREATE OR REPLACE FUNCTION app.actor_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid
$fn$;

CREATE OR REPLACE FUNCTION app.raw_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$fn$;

CREATE OR REPLACE FUNCTION app.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app.platform_admins pa WHERE pa.user_id = app.actor_id()
  )
$fn$;

-- The single tenant context used by every policy. NULL means "no access":
-- unset context, non-member, or a suspended tenant all fail closed.
CREATE OR REPLACE FUNCTION app.tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT CASE
    WHEN app.actor_id() IS NULL OR app.raw_tenant_id() IS NULL THEN NULL
    WHEN NOT EXISTS (
      SELECT 1 FROM app.tenants t
      WHERE t.id = app.raw_tenant_id() AND t.status = 'active'
    ) THEN NULL
    WHEN app.is_platform_admin() THEN app.raw_tenant_id()
    WHEN EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = app.actor_id() AND m.tenant_id = app.raw_tenant_id()
    ) THEN app.raw_tenant_id()
    ELSE NULL
  END
$fn$;

CREATE OR REPLACE FUNCTION app.actor_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT m.role
  FROM app.memberships m
  WHERE m.user_id = app.actor_id() AND m.tenant_id = app.tenant_id()
$fn$;

CREATE OR REPLACE FUNCTION app.is_tenant_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT app.actor_role() = 'tenant_admin'
$fn$;

CREATE OR REPLACE FUNCTION app.can_manage_tenant()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT app.is_platform_admin() OR app.is_tenant_admin()
$fn$;

CREATE OR REPLACE FUNCTION app.actor_membership_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT m.id
  FROM app.memberships m
  WHERE m.user_id = app.actor_id() AND m.tenant_id = app.tenant_id()
$fn$;

CREATE OR REPLACE FUNCTION app.actor_site_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT coalesce(array_agg(ms.site_id), '{}'::uuid[])
  FROM app.membership_sites ms
  WHERE ms.membership_id = app.actor_membership_id()
$fn$;

CREATE OR REPLACE FUNCTION app.has_site(p_site_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT p_site_id = ANY (app.actor_site_ids())
$fn$;

CREATE OR REPLACE FUNCTION app.is_user_in_tenant(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.user_id = p_user_id AND m.tenant_id = app.tenant_id()
  )
$fn$;

CREATE OR REPLACE FUNCTION app.role_rank(p_role text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, app, pg_temp
AS $fn$
  SELECT CASE p_role
    WHEN 'viewer' THEN 1
    WHEN 'site_manager' THEN 2
    WHEN 'tenant_admin' THEN 3
    ELSE 0
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
      AND p.proname IN (
        'actor_id', 'raw_tenant_id', 'is_platform_admin', 'tenant_id',
        'actor_role', 'is_tenant_admin', 'can_manage_tenant',
        'actor_membership_id', 'actor_site_ids', 'has_site',
        'is_user_in_tenant', 'role_rank'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO evstation_definer', fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO evstation_app', fn);
  END LOOP;
END
$own$;

RESET ROLE;
