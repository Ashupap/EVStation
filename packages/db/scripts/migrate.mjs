#!/usr/bin/env node
/**
 * Apply the hand-written SQL migrations in packages/db/sql (source of truth
 * for roles, tables, grants, policies, triggers and functions).
 *
 *   pnpm db:migrate
 *
 * Connects as the superuser (DATABASE_URL_MIGRATOR or infra/compose/.env),
 * applies each file once inside its own transaction and records it in
 * public.schema_migrations. Role passwords are passed as session GUCs.
 */
import { Client } from 'pg';
import { dbCredentials, isCliEntry, migrationFiles } from './lib.mjs';

const LOCK_KEY = 8242001;

export async function migrate({ migratorUrl, ownerPassword, appPassword, log = () => {} }) {
  if (!ownerPassword || !appPassword) {
    throw new Error('migrate requires ownerPassword and appPassword');
  }
  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query("SELECT set_config('evstation.owner_password', $1, false)", [ownerPassword]);
    await client.query("SELECT set_config('evstation.app_password', $1, false)", [appPassword]);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT filename FROM public.schema_migrations');
    const applied = new Set(rows.map((row) => row.filename));

    for (const { file, sql } of migrationFiles()) {
      if (applied.has(file)) continue;
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${file} failed: ${message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (isCliEntry(import.meta.url)) {
  const { migrator, passwords } = dbCredentials();
  await migrate({
    migratorUrl: migrator,
    ownerPassword: passwords.owner,
    appPassword: passwords.app,
    log: (line) => console.log(`db:migrate ${line}`),
  });
  console.log('db:migrate ok');
}
