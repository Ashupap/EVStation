-- 0004_policies.sql — grants, FORCE RLS and policies for the app role.
--
-- Policies apply to evstation_app only. The table owner has no policy and
-- FORCE RLS is on, so even the owner sees zero rows (proven in the SQL test
-- suite). The superuser seed is the only role that bypasses anything.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

ALTER TABLE app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.membership_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_sites FORCE ROW LEVEL SECURITY;
ALTER TABLE app.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_admins FORCE ROW LEVEL SECURITY;
ALTER TABLE app.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_log FORCE ROW LEVEL SECURITY;

RESET ROLE;

-- ── tenants ──────────────────────────────────────────────────────────────
CREATE POLICY tenants_select ON app.tenants
  FOR SELECT TO evstation_app
  USING (
    app.is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM app.memberships m
      WHERE m.user_id = app.actor_id() AND m.tenant_id = app.tenants.id
    )
  );
CREATE POLICY tenants_insert ON app.tenants
  FOR INSERT TO evstation_app
  WITH CHECK (app.is_platform_admin());
CREATE POLICY tenants_update ON app.tenants
  FOR UPDATE TO evstation_app
  USING (
    app.is_platform_admin()
    OR (id = app.tenant_id() AND app.is_tenant_admin())
  )
  WITH CHECK (
    app.is_platform_admin()
    OR (id = app.tenant_id() AND app.is_tenant_admin())
  );

-- ── users (global; visibility limited) ───────────────────────────────────
CREATE POLICY users_select ON app.users
  FOR SELECT TO evstation_app
  USING (
    id = app.actor_id()
    OR app.is_platform_admin()
    OR (app.is_tenant_admin() AND app.is_user_in_tenant(id))
  );
CREATE POLICY users_update_self ON app.users
  FOR UPDATE TO evstation_app
  USING (id = app.actor_id())
  WITH CHECK (id = app.actor_id());

-- ── memberships ──────────────────────────────────────────────────────────
CREATE POLICY memberships_select ON app.memberships
  FOR SELECT TO evstation_app
  USING (
    user_id = app.actor_id()
    OR app.is_platform_admin()
    OR (tenant_id = app.tenant_id() AND app.is_tenant_admin())
  );
CREATE POLICY memberships_insert ON app.memberships
  FOR INSERT TO evstation_app
  WITH CHECK (tenant_id = app.tenant_id() AND app.can_manage_tenant());
CREATE POLICY memberships_update ON app.memberships
  FOR UPDATE TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant())
  WITH CHECK (tenant_id = app.tenant_id() AND app.can_manage_tenant());
CREATE POLICY memberships_delete ON app.memberships
  FOR DELETE TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant());

-- ── sites ────────────────────────────────────────────────────────────────
CREATE POLICY sites_select ON app.sites
  FOR SELECT TO evstation_app
  USING (
    tenant_id = app.tenant_id()
    AND (
      app.can_manage_tenant()
      OR (app.actor_role() = 'viewer')
      OR app.has_site(id)
    )
  );
CREATE POLICY sites_insert ON app.sites
  FOR INSERT TO evstation_app
  WITH CHECK (tenant_id = app.tenant_id() AND app.can_manage_tenant());
CREATE POLICY sites_update ON app.sites
  FOR UPDATE TO evstation_app
  USING (
    tenant_id = app.tenant_id()
    AND (app.can_manage_tenant() OR app.has_site(id))
  )
  WITH CHECK (
    tenant_id = app.tenant_id()
    AND (app.can_manage_tenant() OR app.has_site(id))
  );
CREATE POLICY sites_delete ON app.sites
  FOR DELETE TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant());

-- ── membership_sites ─────────────────────────────────────────────────────
CREATE POLICY membership_sites_select ON app.membership_sites
  FOR SELECT TO evstation_app
  USING (
    membership_id = app.actor_membership_id()
    OR (tenant_id = app.tenant_id() AND app.can_manage_tenant())
  );
CREATE POLICY membership_sites_write ON app.membership_sites
  FOR ALL TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant())
  WITH CHECK (tenant_id = app.tenant_id() AND app.can_manage_tenant());

-- ── platform_admins ──────────────────────────────────────────────────────
CREATE POLICY platform_admins_select ON app.platform_admins
  FOR SELECT TO evstation_app
  USING (user_id = app.actor_id() OR app.is_platform_admin());

-- ── invitations ──────────────────────────────────────────────────────────
CREATE POLICY invitations_select ON app.invitations
  FOR SELECT TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant());
CREATE POLICY invitations_insert ON app.invitations
  FOR INSERT TO evstation_app
  WITH CHECK (
    tenant_id = app.tenant_id()
    AND app.can_manage_tenant()
    AND invited_by = app.actor_id()
  );
CREATE POLICY invitations_update ON app.invitations
  FOR UPDATE TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant())
  WITH CHECK (tenant_id = app.tenant_id() AND app.can_manage_tenant());

-- ── audit_log (append-only from the app) ─────────────────────────────────
CREATE POLICY audit_log_insert ON app.audit_log
  FOR INSERT TO evstation_app
  WITH CHECK (
    actor_id = app.actor_id()
    AND (
      tenant_id IS NULL
      OR tenant_id = app.tenant_id()
      OR app.is_platform_admin()
    )
  );
CREATE POLICY audit_log_select ON app.audit_log
  FOR SELECT TO evstation_app
  USING (
    app.is_platform_admin()
    OR (tenant_id = app.tenant_id() AND app.is_tenant_admin())
  );

-- ── grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
-- The definer-owned functions execute as evstation_definer, so that role
-- needs the table privileges its queries and writes require (BYPASSRLS only
-- bypasses policies, not GRANTs).
GRANT SELECT ON app.tenants, app.users, app.memberships, app.sites,
  app.membership_sites, app.platform_admins, app.invitations
  TO evstation_definer;
GRANT SELECT, INSERT, UPDATE ON app.tenants TO evstation_app;
GRANT SELECT ON app.users TO evstation_app;
GRANT UPDATE (display_name, updated_at) ON app.users TO evstation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.memberships TO evstation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.sites TO evstation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.membership_sites TO evstation_app;
GRANT SELECT ON app.platform_admins TO evstation_app;
GRANT SELECT, INSERT, UPDATE ON app.invitations TO evstation_app;
GRANT SELECT, INSERT ON app.audit_log TO evstation_app;
