import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { seedDev, SEED_IDS } from '../scripts/seed.mjs';

export const OWNER_PASSWORD = 'owner-test-password';
export const APP_PASSWORD = 'app-test-password';
const SUPERUSER_PASSWORD = 'superuser-test-password';

export const OUTSIDER_ID = '00000000-0000-4000-8000-000000000099';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  migratorUrl: string;
  ownerUrl: string;
  appUrl: string;
  superuser: Client;
  app: Client;
  owner: Client;
}

function urlFor(base: string, user: string, password: string) {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

export async function startDb({ untilFile }: { untilFile?: string } = {}): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgis/postgis:16-3.5')
    .withUsername('evstation')
    .withPassword(SUPERUSER_PASSWORD)
    .withDatabase('evstation')
    .start();
  const migratorUrl = container.getConnectionUri();
  await migrate({
    migratorUrl,
    ownerPassword: OWNER_PASSWORD,
    appPassword: APP_PASSWORD,
    ...(untilFile ? { untilFile } : {}),
  });
  const appUrl = urlFor(migratorUrl, 'evstation_app', APP_PASSWORD);
  const ownerUrl = urlFor(migratorUrl, 'evstation_owner', OWNER_PASSWORD);
  const superuser = new Client({ connectionString: migratorUrl });
  const app = new Client({ connectionString: appUrl });
  const owner = new Client({ connectionString: ownerUrl });
  await Promise.all([superuser.connect(), app.connect(), owner.connect()]);
  return { container, migratorUrl, ownerUrl, appUrl, superuser, app, owner };
}

export async function stopDb(db: TestDb) {
  await Promise.all([db.superuser.end(), db.app.end(), db.owner.end()]);
  await db.container.stop();
}

export async function resetDb(db: TestDb) {
  await db.superuser.query(
    `TRUNCATE app.ingestion_events, app.pending_transaction_starts,
       app.station_status_events, app.session_meter_values, app.sessions,
       app.connectors, app.station_runtime_state, app.stations,
       app.email_outbox, app.audit_log, app.invitations,
       app.membership_sites, app.memberships, app.sites, app.platform_admins,
       app.users, app.tenants CASCADE`,
  );
  await seedDev({ migratorUrl: db.migratorUrl });
  await db.superuser.query(
    `INSERT INTO app.users (id, email, email_verified, display_name)
     VALUES ($1, 'outsider@example.com', true, 'Outsider')`,
    [OUTSIDER_ID],
  );
}

export interface Ctx {
  actor?: string;
  tenant?: string;
}

/** Run fn inside a transaction with (optional) actor/tenant GUCs; always rollback. */
export async function appTx<T>(
  db: TestDb,
  ctx: Ctx,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await db.app.query('BEGIN');
  try {
    if (ctx.actor !== undefined) {
      await db.app.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actor]);
    }
    if (ctx.tenant !== undefined) {
      await db.app.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenant]);
    }
    return await fn(db.app);
  } finally {
    await db.app.query('ROLLBACK');
  }
}

/** Run fn in a transaction with actor/tenant GUCs and COMMIT it. */
export async function appCommit<T>(
  db: TestDb,
  ctx: Ctx,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await db.app.query('BEGIN');
  try {
    if (ctx.actor !== undefined) {
      await db.app.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actor]);
    }
    if (ctx.tenant !== undefined) {
      await db.app.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenant]);
    }
    const result = await fn(db.app);
    await db.app.query('COMMIT');
    return result;
  } catch (error) {
    await db.app.query('ROLLBACK');
    throw error;
  }
}

export async function tableNamesInApp(db: TestDb): Promise<string[]> {
  const { rows } = await db.superuser.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename",
  );
  return rows.map((row) => row.tablename);
}

export { SEED_IDS };
