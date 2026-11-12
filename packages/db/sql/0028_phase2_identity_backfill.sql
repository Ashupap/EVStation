-- 0028_phase2_identity_backfill.sql — collision-safe backfill helper for
-- legacy rows with NULL org_code/site_code. Run as the migration/superuser.

SET ROLE evstation_owner;
SET search_path = app, pg_catalog;

CREATE OR REPLACE FUNCTION app.backfill_org_codes()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  WITH candidates AS (
    SELECT id,
           upper(substring(regexp_replace(slug, '[^a-z0-9]', '', 'g'), 1, 8)) AS base,
           row_number() OVER (
             PARTITION BY upper(substring(regexp_replace(slug, '[^a-z0-9]', '', 'g'), 1, 8))
             ORDER BY created_at, id
           ) AS duplicate_rank,
           row_number() OVER (ORDER BY created_at, id) AS overall_rank
    FROM app.tenants
    WHERE org_code IS NULL
  )
  UPDATE app.tenants t
  SET org_code = CASE
    WHEN length(c.base) >= 2 AND c.duplicate_rank = 1 THEN c.base
    WHEN length(c.base) >= 6 THEN left(c.base, 6) || lpad(c.duplicate_rank::text, 2, '0')
    ELSE 'T' || lpad(c.overall_rank::text, 7, '0')
  END
  FROM candidates c
  WHERE t.id = c.id;
END
$fn$;

CREATE OR REPLACE FUNCTION app.backfill_site_codes()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $fn$
BEGIN
  WITH candidates AS (
    SELECT id,
           tenant_id,
           upper(substring(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 1, 6)) AS base,
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
    WHEN length(c.base) >= 2 AND c.duplicate_rank = 1 THEN c.base
    ELSE 'S' || lpad(c.tenant_rank::text, 5, '0')
  END
  FROM candidates c
  WHERE s.id = c.id;
END
$fn$;

RESET ROLE;
