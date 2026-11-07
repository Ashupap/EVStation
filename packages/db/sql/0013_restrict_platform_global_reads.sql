-- 0013_restrict_platform_global_reads.sql — platform admins need an explicit
-- tenant context to read tenant-scoped data (review MEDIUM 7, ADR-0011).
--
-- Previously users/memberships/audit_log policies had a bare
-- `app.is_platform_admin()` branch, so a platform admin with no tenant GUC
-- could enumerate every tenant's users, memberships and audit log. The tenant
-- directory itself stays global (it powers the tenant switcher); everything
-- else is reachable only after selecting a tenant, which also makes the read
-- auditable by tenant.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

DROP POLICY users_select ON app.users;
CREATE POLICY users_select ON app.users
  FOR SELECT TO evstation_app
  USING (
    id = app.actor_id()
    OR (app.can_manage_tenant() AND app.is_user_in_tenant(id))
  );

DROP POLICY memberships_select ON app.memberships;
CREATE POLICY memberships_select ON app.memberships
  FOR SELECT TO evstation_app
  USING (
    user_id = app.actor_id()
    OR (tenant_id = app.tenant_id() AND app.can_manage_tenant())
  );

DROP POLICY audit_log_select ON app.audit_log;
CREATE POLICY audit_log_select ON app.audit_log
  FOR SELECT TO evstation_app
  USING (tenant_id = app.tenant_id() AND app.can_manage_tenant());

RESET ROLE;
