-- 0015_least_privilege.sql — narrow app UPDATE and default function EXECUTE
-- (review MEDIUM 10 / MEDIUM 11).
--
-- 11. Table-level UPDATE let the app rewrite immutable/audit columns even
--     where triggers or RLS later rejected the value. Grant only columns a
--     Phase 1 UI needs: tenant status; membership role; site name/address/
--     status; user display_name; invitation revoked_at. membership_sites rows
--     are insert/delete only.
-- 10. Functions default to EXECUTE for PUBLIC. Every definer function already
--     revokes it explicitly, but a future migration could forget. Set default
--     privileges for both function-owning roles so new functions start closed.

REVOKE UPDATE ON app.tenants FROM evstation_app;
GRANT UPDATE (status) ON app.tenants TO evstation_app;

REVOKE UPDATE ON app.memberships FROM evstation_app;
GRANT UPDATE (role) ON app.memberships TO evstation_app;

REVOKE UPDATE ON app.sites FROM evstation_app;
GRANT UPDATE (name, address, status) ON app.sites TO evstation_app;

REVOKE UPDATE ON app.membership_sites FROM evstation_app;

REVOKE UPDATE (updated_at) ON app.users FROM evstation_app;

GRANT UPDATE (revoked_at) ON app.invitations TO evstation_app;

ALTER DEFAULT PRIVILEGES FOR ROLE evstation_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE evstation_definer
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
