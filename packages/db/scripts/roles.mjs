#!/usr/bin/env node
/**
 * Create/update the Phase 1 database roles (ADR-0011).
 *
 *   pnpm db:roles
 *
 * Run with the superuser (DATABASE_URL_MIGRATOR or infra/compose/.env).
 * Passwords come from env and are passed as session-local GUCs; they are
 * never printed and never appear in the SQL file or process arguments.
 * Re-running converges role attributes and passwords to the current env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { dbCredentials, dbRoot, isCliEntry } from './lib.mjs';

export const rolesSql = fs.readFileSync(path.join(dbRoot, 'sql/0001_roles.sql'), 'utf8');

export async function bootstrapRoles({ migratorUrl, ownerPassword, appPassword }) {
  if (!ownerPassword || !appPassword) {
    throw new Error('bootstrapRoles requires ownerPassword and appPassword');
  }
  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query("SELECT set_config('evstation.owner_password', $1, false)", [ownerPassword]);
    await client.query("SELECT set_config('evstation.app_password', $1, false)", [appPassword]);
    await client.query(rolesSql);
  } finally {
    await client.end();
  }
}

if (isCliEntry(import.meta.url)) {
  const { migrator, passwords } = dbCredentials();
  await bootstrapRoles({
    migratorUrl: migrator,
    ownerPassword: passwords.owner,
    appPassword: passwords.app,
  });
  console.log('db:roles ok (evstation_owner, evstation_app, evstation_definer converged)');
}
