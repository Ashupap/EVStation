#!/usr/bin/env node
/**
 * Dev/test seed (ADR-0011). Runs as the container superuser, refuses to run
 * with NODE_ENV=production. Idempotent: safe to re-run.
 *
 * Keycloak users are created separately by the dev Keycloak seeder with the
 * same fixed ids (id = Keycloak `sub`); this seed only owns our DB rows.
 */
import { Client } from 'pg';
import { dbCredentials, isCliEntry } from './lib.mjs';

export const SEED_IDS = {
  platformAdmin: '00000000-0000-4000-8000-000000000001',
  acmeAdmin: '00000000-0000-4000-8000-000000000002',
  betaAdmin: '00000000-0000-4000-8000-000000000003',
  acmeSiteManager: '00000000-0000-4000-8000-000000000004',
  acmeViewer: '00000000-0000-4000-8000-000000000005',
  acmeTenant: '10000000-0000-4000-8000-000000000001',
  betaTenant: '10000000-0000-4000-8000-000000000002',
  acmeSite1: '20000000-0000-4000-8000-000000000001',
  acmeSite2: '20000000-0000-4000-8000-000000000002',
  betaSite1: '20000000-0000-4000-8000-000000000003',
};

const USERS = [
  [SEED_IDS.platformAdmin, 'platform@evstation.dev', 'Platform Admin'],
  [SEED_IDS.acmeAdmin, 'admin@acme.example', 'Acme Admin'],
  [SEED_IDS.betaAdmin, 'admin@beta.example', 'Beta Admin'],
  [SEED_IDS.acmeSiteManager, 'manager@acme.example', 'Acme Site Manager'],
  [SEED_IDS.acmeViewer, 'viewer@acme.example', 'Acme Viewer'],
];

export async function seedDev({ migratorUrl }) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to seed development data when NODE_ENV=production');
  }
  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO app.tenants (id, name, slug, org_code)
       VALUES ($1, 'Acme Charging', 'acme', 'ACME'), ($2, 'Beta Mobility', 'beta', 'BETA')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
      [SEED_IDS.acmeTenant, SEED_IDS.betaTenant],
    );

    for (const [id, email, displayName] of USERS) {
      await client.query(
        `INSERT INTO app.users (id, email, email_verified, display_name)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (id) DO UPDATE
           SET email = EXCLUDED.email, email_verified = true,
               display_name = EXCLUDED.display_name`,
        [id, email, displayName],
      );
    }

    await client.query(
      `INSERT INTO app.platform_admins (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [SEED_IDS.platformAdmin],
    );

    await client.query(
      `INSERT INTO app.sites (id, tenant_id, name, address, site_code)
       VALUES ($1, $3, 'Acme Hub — Bengaluru', 'Bengaluru, KA', 'BLR'),
              ($2, $3, 'Acme Depot — Pune', 'Pune, MH', 'PUN'),
              ($4, $5, 'Beta Hub — Mumbai', 'Mumbai, MH', 'BOM')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address`,
      [
        SEED_IDS.acmeSite1,
        SEED_IDS.acmeSite2,
        SEED_IDS.acmeTenant,
        SEED_IDS.betaSite1,
        SEED_IDS.betaTenant,
      ],
    );

    const memberships = [
      [SEED_IDS.acmeTenant, SEED_IDS.acmeAdmin, 'tenant_admin'],
      [SEED_IDS.betaTenant, SEED_IDS.betaAdmin, 'tenant_admin'],
      [SEED_IDS.acmeTenant, SEED_IDS.acmeSiteManager, 'site_manager'],
      [SEED_IDS.acmeTenant, SEED_IDS.acmeViewer, 'viewer'],
    ];
    for (const [tenantId, userId, role] of memberships) {
      await client.query(
        `INSERT INTO app.memberships (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
        [tenantId, userId, role],
      );
    }

    await client.query(
      `INSERT INTO app.membership_sites (membership_id, site_id, tenant_id)
       SELECT m.id, $1, $2 FROM app.memberships m
       WHERE m.user_id = $3 AND m.tenant_id = $2
       ON CONFLICT DO NOTHING`,
      [SEED_IDS.acmeSite1, SEED_IDS.acmeTenant, SEED_IDS.acmeSiteManager],
    );

    await client.query('COMMIT');
    console.log('db:seed ok (1 platform admin, 2 tenants, 3 sites, 4 memberships)');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (isCliEntry(import.meta.url)) {
  const { migrator } = dbCredentials();
  await seedDev({ migratorUrl: migrator });
}
