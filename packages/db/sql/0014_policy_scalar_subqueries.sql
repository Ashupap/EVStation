-- 0014_policy_scalar_subqueries.sql — hoist stable helpers out of per-row
-- policy evaluation (review HIGH 8 / MEDIUM 12).
--
-- A bare call like app.can_manage_tenant() in a policy filter is evaluated
-- once per candidate row even though it is STABLE and has no arguments. On a
-- 100k-row tenant, `SELECT count(*) FROM app.sites` spent ~2.9s on the first
-- 1k rows and did not finish in five minutes. Wrapping each zero-argument
-- helper in a scalar subquery turns it into an InitPlan evaluated once per
-- query. The per-row site scope is an array membership against one hoisted
-- app.actor_site_ids() result instead of a helper call per row, and
-- users_select inlines the membership probe so it can use
-- memberships_user_tenant_key.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

-- ── tenants ──────────────────────────────────────────────────────────────
DROP POLICY tenants_select ON app.tenants;
CREATE POLICY tenants_select ON app.tenants
  FOR SELECT TO evstation_app
  USING (
    (SELECT app.is_platform_admin())
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = (SELECT app.actor_id()) AND m.tenant_id = app.tenants.id
    )
  );

DROP POLICY tenants_insert ON app.tenants;
CREATE POLICY tenants_insert ON app.tenants
  FOR INSERT TO evstation_app
  WITH CHECK ((SELECT app.is_platform_admin()));

DROP POLICY tenants_update ON app.tenants;
CREATE POLICY tenants_update ON app.tenants
  FOR UPDATE TO evstation_app
  USING (
    (SELECT app.is_platform_admin())
    OR (id = (SELECT app.tenant_id()) AND (SELECT app.is_tenant_admin()))
  )
  WITH CHECK (
    (SELECT app.is_platform_admin())
    OR (id = (SELECT app.tenant_id()) AND (SELECT app.is_tenant_admin()))
  );

-- ── users ────────────────────────────────────────────────────────────────
DROP POLICY users_select ON app.users;
CREATE POLICY users_select ON app.users
  FOR SELECT TO evstation_app
  USING (
    id = (SELECT app.actor_id())
    OR (
      (SELECT app.can_manage_tenant())
      AND EXISTS (
        SELECT 1 FROM app.memberships m
        WHERE m.user_id = app.users.id AND m.tenant_id = (SELECT app.tenant_id())
      )
    )
  );

DROP POLICY users_update_self ON app.users;
CREATE POLICY users_update_self ON app.users
  FOR UPDATE TO evstation_app
  USING (id = (SELECT app.actor_id()))
  WITH CHECK (id = (SELECT app.actor_id()));

-- ── memberships ──────────────────────────────────────────────────────────
DROP POLICY memberships_select ON app.memberships;
CREATE POLICY memberships_select ON app.memberships
  FOR SELECT TO evstation_app
  USING (
    user_id = (SELECT app.actor_id())
    OR (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant()))
  );

DROP POLICY memberships_insert ON app.memberships;
CREATE POLICY memberships_insert ON app.memberships
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

DROP POLICY memberships_update ON app.memberships;
CREATE POLICY memberships_update ON app.memberships
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

DROP POLICY memberships_delete ON app.memberships;
CREATE POLICY memberships_delete ON app.memberships
  FOR DELETE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

-- ── sites ────────────────────────────────────────────────────────────────
DROP POLICY sites_select ON app.sites;
CREATE POLICY sites_select ON app.sites
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR (SELECT app.actor_role()) = 'viewer'
      OR id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );

DROP POLICY sites_insert ON app.sites;
CREATE POLICY sites_insert ON app.sites
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

DROP POLICY sites_update ON app.sites;
CREATE POLICY sites_update ON app.sites
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (
      (SELECT app.can_manage_tenant())
      OR id = ANY (((SELECT app.actor_site_ids()))::uuid[])
    )
  );

DROP POLICY sites_delete ON app.sites;
CREATE POLICY sites_delete ON app.sites
  FOR DELETE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

-- ── membership_sites ─────────────────────────────────────────────────────
DROP POLICY membership_sites_select ON app.membership_sites;
CREATE POLICY membership_sites_select ON app.membership_sites
  FOR SELECT TO evstation_app
  USING (
    membership_id = (SELECT app.actor_membership_id())
    OR (
      tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
    )
  );

DROP POLICY membership_sites_write ON app.membership_sites;
CREATE POLICY membership_sites_write ON app.membership_sites
  FOR ALL TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

-- ── platform_admins ──────────────────────────────────────────────────────
DROP POLICY platform_admins_select ON app.platform_admins;
CREATE POLICY platform_admins_select ON app.platform_admins
  FOR SELECT TO evstation_app
  USING (
    user_id = (SELECT app.actor_id()) OR (SELECT app.is_platform_admin())
  );

-- ── invitations ──────────────────────────────────────────────────────────
DROP POLICY invitations_select ON app.invitations;
CREATE POLICY invitations_select ON app.invitations
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

DROP POLICY invitations_insert ON app.invitations;
CREATE POLICY invitations_insert ON app.invitations
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id())
    AND (SELECT app.can_manage_tenant())
    AND invited_by = (SELECT app.actor_id())
  );

DROP POLICY invitations_update ON app.invitations;
CREATE POLICY invitations_update ON app.invitations
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  )
  WITH CHECK (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

-- ── audit_log ────────────────────────────────────────────────────────────
DROP POLICY audit_log_insert ON app.audit_log;
CREATE POLICY audit_log_insert ON app.audit_log
  FOR INSERT TO evstation_app
  WITH CHECK (
    actor_id = (SELECT app.actor_id())
    AND (
      tenant_id IS NULL
      OR tenant_id = (SELECT app.tenant_id())
      OR (SELECT app.is_platform_admin())
    )
  );

DROP POLICY audit_log_select ON app.audit_log;
CREATE POLICY audit_log_select ON app.audit_log
  FOR SELECT TO evstation_app
  USING (
    tenant_id = (SELECT app.tenant_id()) AND (SELECT app.can_manage_tenant())
  );

RESET ROLE;
