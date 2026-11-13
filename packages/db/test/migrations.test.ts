import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../scripts/migrate.mjs';
import { checksumSql, migrationFiles } from '../scripts/lib.mjs';
import {
  APP_PASSWORD,
  INGEST_PASSWORD,
  JOBS_PASSWORD,
  OWNER_PASSWORD,
  startDb,
  stopDb,
  type TestDb,
} from './helpers.js';

let db: TestDb;

beforeAll(async () => {
  db = await startDb();
});

afterAll(async () => {
  await stopDb(db);
});

test('0020 upgrades legacy duplicate/short org and site codes safely', async () => {
  const legacy = await startDb({ untilFile: '0019_email_outbox_dispatch_hardening.sql' });
  try {
    const tenantOne = '90000000-0000-4000-8000-000000000301';
    const tenantTwo = '90000000-0000-4000-8000-000000000302';
    await legacy.superuser.query(
      `INSERT INTO app.tenants (id, name, slug) VALUES
       ($1, 'Legacy A', 'duplicate-long-name-a'),
       ($2, 'Legacy B', 'duplicate-long-name-b')`,
      [tenantOne, tenantTwo],
    );
    await legacy.superuser.query(
      `INSERT INTO app.sites (id, tenant_id, name) VALUES
       ('90000000-0000-4000-8000-000000000401', $1, 'A'),
       ('90000000-0000-4000-8000-000000000402', $1, 'Same Site'),
       ('90000000-0000-4000-8000-000000000403', $1, 'Same Site')`,
      [tenantOne],
    );
    await migrate({
      migratorUrl: legacy.migratorUrl,
      ownerPassword: OWNER_PASSWORD,
      appPassword: APP_PASSWORD,
      ingestPassword: INGEST_PASSWORD,
      jobsPassword: JOBS_PASSWORD,
    });
    const tenants = await legacy.superuser.query<{ org_code: string }>(
      'SELECT org_code FROM app.tenants WHERE id IN ($1, $2) ORDER BY org_code',
      [tenantOne, tenantTwo],
    );
    expect(tenants.rows).toHaveLength(2);
    expect(tenants.rows[0]?.org_code).toMatch(/^[A-Z0-9]{2,8}$/u);
    expect(tenants.rows[0]?.org_code).not.toBe(tenants.rows[1]?.org_code);
    const sites = await legacy.superuser.query<{ site_code: string }>(
      'SELECT site_code FROM app.sites WHERE tenant_id = $1 ORDER BY site_code',
      [tenantOne],
    );
    expect(sites.rows).toHaveLength(3);
    const codes = sites.rows.map((row) => row.site_code);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code).toMatch(/^[A-Z0-9]{2,6}$/u);
  } finally {
    await stopDb(legacy);
  }
});

describe('migration integrity', () => {
  test('records a sha256 checksum for every applied migration', async () => {
    const { rows } = await db.superuser.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM public.schema_migrations ORDER BY filename',
    );
    const expected = migrationFiles();
    expect(rows.map((row) => row.filename)).toEqual(expected.map((entry) => entry.file));
    for (const row of rows) {
      const source = expected.find((entry) => entry.file === row.filename);
      expect(source, row.filename).toBeTruthy();
      expect(row.checksum, row.filename).toBe(checksumSql(source!.sql));
    }
  });

  test('fails closed when an applied migration file changes', async () => {
    const filename = '0008_ensure_actor.sql';
    const original = await db.superuser.query<{ checksum: string }>(
      'SELECT checksum FROM public.schema_migrations WHERE filename = $1',
      [filename],
    );
    await db.superuser.query(
      "UPDATE public.schema_migrations SET checksum = 'deadbeef' WHERE filename = $1",
      [filename],
    );

    try {
      await expect(
        migrate({
          migratorUrl: db.migratorUrl,
          ownerPassword: OWNER_PASSWORD,
          appPassword: APP_PASSWORD,
          ingestPassword: INGEST_PASSWORD,
          jobsPassword: JOBS_PASSWORD,
        }),
      ).rejects.toThrow(/0008_ensure_actor\.sql checksum mismatch/);
    } finally {
      await db.superuser.query(
        'UPDATE public.schema_migrations SET checksum = $2 WHERE filename = $1',
        [filename, original.rows[0]!.checksum],
      );
    }
  });

  test('baselines legacy NULL checksums instead of failing', async () => {
    const filename = '0008_ensure_actor.sql';
    await db.superuser.query(
      'UPDATE public.schema_migrations SET checksum = NULL WHERE filename = $1',
      [filename],
    );

    await migrate({
      migratorUrl: db.migratorUrl,
      ownerPassword: OWNER_PASSWORD,
      appPassword: APP_PASSWORD,
      ingestPassword: INGEST_PASSWORD,
      jobsPassword: JOBS_PASSWORD,
    });

    const { rows } = await db.superuser.query<{ checksum: string }>(
      'SELECT checksum FROM public.schema_migrations WHERE filename = $1',
      [filename],
    );
    const source = migrationFiles().find((entry) => entry.file === filename);
    expect(rows[0]?.checksum).toBe(checksumSql(source!.sql));
  });
});
