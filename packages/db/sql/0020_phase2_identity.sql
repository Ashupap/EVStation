-- 0020_phase2_identity.sql — Phase 2 org/site codes (ADR pending: station identity).
--
-- org_code and site_code are stable, immutable human codes used in station_ref:
--   <ORG>-<SITE>-<NNN>
-- They are nullable for legacy rows during migration; Phase 2 station creation
-- requires both and the station trigger rejects missing/unbound codes.

ALTER TABLE app.tenants ADD COLUMN org_code text;
ALTER TABLE app.sites ADD COLUMN site_code text;

ALTER TABLE app.tenants
  ADD CONSTRAINT tenants_org_code_format
  CHECK (org_code IS NULL OR org_code ~ '^[A-Z0-9]{2,8}$');
ALTER TABLE app.sites
  ADD CONSTRAINT sites_site_code_format
  CHECK (site_code IS NULL OR site_code ~ '^[A-Z0-9]{2,6}$');

-- Backfill as superuser (owner would be blocked by FORCE RLS). Codes are
-- derived once; the guard triggers below make them immutable afterwards.
UPDATE app.tenants
SET org_code = upper(substring(regexp_replace(slug, '[^a-z0-9]', '', 'g'), 1, 8))
WHERE org_code IS NULL;

WITH candidates AS (
  SELECT id,
         tenant_id,
         upper(substring(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 1, 6)) AS candidate,
         row_number() OVER (
           PARTITION BY tenant_id, upper(substring(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 1, 6))
           ORDER BY created_at, id
         ) AS duplicate_rank,
         row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS tenant_rank
  FROM app.sites
  WHERE site_code IS NULL
)
UPDATE app.sites s
SET site_code = CASE
  WHEN c.duplicate_rank = 1 AND length(c.candidate) >= 2 THEN c.candidate
  ELSE 'S' || lpad(c.tenant_rank::text, 5, '0')
END
FROM candidates c
WHERE s.id = c.id;

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

ALTER TABLE app.tenants
  ADD CONSTRAINT tenants_id_org_code_key UNIQUE (id, org_code);
CREATE UNIQUE INDEX tenants_org_code_key ON app.tenants (org_code)
  WHERE org_code IS NOT NULL;
CREATE UNIQUE INDEX sites_tenant_site_code_key ON app.sites (tenant_id, site_code)
  WHERE site_code IS NOT NULL;

CREATE OR REPLACE FUNCTION app.guard_tenant_org_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.org_code IS NOT NULL
     AND NEW.org_code IS DISTINCT FROM OLD.org_code THEN
    RAISE EXCEPTION 'tenant org_code is immutable';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app.guard_tenant_org_code() FROM PUBLIC;
CREATE TRIGGER tenants_guard_org_code
  BEFORE INSERT OR UPDATE ON app.tenants
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_org_code();

CREATE OR REPLACE FUNCTION app.guard_site_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.site_code IS NOT NULL
     AND NEW.site_code IS DISTINCT FROM OLD.site_code THEN
    RAISE EXCEPTION 'site site_code is immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'site tenant_id is immutable';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION app.guard_site_code() FROM PUBLIC;
CREATE TRIGGER sites_guard_site_code
  BEFORE INSERT OR UPDATE ON app.sites
  FOR EACH ROW EXECUTE FUNCTION app.guard_site_code();

RESET ROLE;
