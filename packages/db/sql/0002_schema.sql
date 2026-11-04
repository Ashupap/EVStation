-- 0002_schema.sql — Phase 1 schema (ADR-0011). Objects are owned by
-- evstation_owner (NOBYPASSRLS). RLS policies/grants land in 0004.
--
-- Tenancy model:
--   users are global (id = Keycloak `sub`); tenant access comes only from
--   memberships. membership_sites carries a redundant tenant_id plus composite
--   FKs so a cross-tenant (membership, site) pair is structurally impossible.

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION evstation_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO evstation_app, evstation_definer;

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE TABLE app.tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.users (
  id             uuid PRIMARY KEY,
  external_id    text UNIQUE,
  email          text NOT NULL CHECK (position('@' IN email) > 1),
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON app.users (lower(email));

CREATE TABLE app.memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('tenant_admin', 'site_manager', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_user_tenant_key UNIQUE (user_id, tenant_id),
  CONSTRAINT memberships_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX memberships_tenant_idx ON app.memberships (tenant_id);

CREATE TABLE app.sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  address    text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX sites_tenant_idx ON app.sites (tenant_id);

CREATE TABLE app.membership_sites (
  membership_id uuid NOT NULL,
  site_id       uuid NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, site_id),
  CONSTRAINT membership_sites_membership_fk
    FOREIGN KEY (membership_id, tenant_id)
    REFERENCES app.memberships (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT membership_sites_site_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES app.sites (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX membership_sites_site_idx ON app.membership_sites (site_id);

CREATE TABLE app.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenants (id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (position('@' IN email) > 1),
  role         text NOT NULL CHECK (role IN ('tenant_admin', 'site_manager', 'viewer')),
  site_ids     uuid[] NOT NULL DEFAULT '{}',
  invited_by   uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES app.users (id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_pending_email_key
  ON app.invitations (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_tenant_idx ON app.invitations (tenant_id);

CREATE TABLE app.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  tenant_id     uuid REFERENCES app.tenants (id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES app.users (id) ON DELETE SET NULL,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  outcome       text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  request_id    text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_tenant_time_idx ON app.audit_log (tenant_id, created_at DESC);
CREATE INDEX audit_log_actor_time_idx ON app.audit_log (actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app.touch_updated_at() FROM PUBLIC;

CREATE TRIGGER tenants_touch_updated_at
  BEFORE UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER memberships_touch_updated_at
  BEFORE UPDATE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER sites_touch_updated_at
  BEFORE UPDATE ON app.sites
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

RESET ROLE;
