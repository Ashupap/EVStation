import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../scripts/migrate.mjs';
import { checksumSql, migrationFiles } from '../scripts/lib.mjs';
import { APP_PASSWORD, OWNER_PASSWORD, startDb, stopDb, type TestDb } from './helpers.js';

let db: TestDb;

beforeAll(async () => {
  db = await startDb();
});

afterAll(async () => {
  await stopDb(db);
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
    });

    const { rows } = await db.superuser.query<{ checksum: string }>(
      'SELECT checksum FROM public.schema_migrations WHERE filename = $1',
      [filename],
    );
    const source = migrationFiles().find((entry) => entry.file === filename);
    expect(rows[0]?.checksum).toBe(checksumSql(source!.sql));
  });
});
