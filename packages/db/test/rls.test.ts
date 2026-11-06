import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  APP_PASSWORD,
  OUTSIDER_ID,
  OWNER_PASSWORD,
  SEED_IDS,
  appCommit,
  appTx,
  resetDb,
  startDb,
  stopDb,
  type TestDb,
} from './helpers.js';

const A = SEED_IDS.acmeTenant;
const B = SEED_IDS.betaTenant;
const ADMIN_A = SEED_IDS.acmeAdmin;
const ADMIN_B = SEED_IDS.betaAdmin;
const SITE_MANAGER_A = SEED_IDS.acmeSiteManager;
const VIEWER_A = SEED_IDS.acmeViewer;
const PLATFORM = SEED_IDS.platformAdmin;
const SITE_A1 = SEED_IDS.acmeSite1;
const SITE_A2 = SEED_IDS.acmeSite2;
const SITE_B1 = SEED_IDS.betaSite1;
const EVSTATION_IDS = {
  acmeAdmin: ADMIN_A,
  betaAdmin: ADMIN_B,
  acmeSiteManager: SITE_MANAGER_A,
  acmeViewer: VIEWER_A,
  platformAdmin: PLATFORM,
  acmeTenant: A,
  betaTenant: B,
  acmeSite1: SITE_A1,
  acmeSite2: SITE_A2,
  betaSite1: SITE_B1,
};

let db: TestDb;

beforeAll(async () => {
  db = await startDb();
});

afterAll(async () => {
  await stopDb(db);
});

beforeEach(async () => {
  await resetDb(db);
});

async function fail(client: Client, sql: string, params: unknown[] = []) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await client.query(sql, params);
    throw new Error(`expected failure but query succeeded: ${sql}`);
  } catch (error) {
    const err = error as { code?: string; message: string };
    if (err.message.startsWith('expected failure but')) throw err;
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    return err;
  }
}

function token() {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}

async function emails(client: TestDb['app']): Promise<string[]> {
  const { rows } = await client.query<{ email: string }>(
    'SELECT email FROM app.users ORDER BY email',
  );
  return rows.map((row) => row.email);
}

async function count(client: TestDb['app'], table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.${table}`,
  );
  return Number(rows[0]?.n);
}

async function insertInvitation(
  email: string,
  role: string,
  siteIds: string[] = [],
  expiresAt = "now() + interval '1 day'",
) {
  const { hash, raw } = token();
  await appCommit(db, { actor: ADMIN_A, tenant: A }, async (client) => {
    await client.query(
      `INSERT INTO app.invitations (tenant_id, email, role, site_ids, invited_by, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${expiresAt})`,
      [A, email, role, siteIds, ADMIN_A, hash],
    );
  });
  return { raw, hash };
}

async function accept(userId: string, email: string, hash: string, verified = true) {
  const { rows } = await db.app.query<{ tenant_id: string; membership_id: string; role: string }>(
    'SELECT * FROM app.accept_invitation($1, $2, $3, $4)',
    [hash, userId, email, verified],
  );
  return rows[0];
}

describe('role attributes and object ownership', () => {
  test('app/owner cannot bypass RLS; definer is NOLOGIN + BYPASSRLS; app owns nothing', async () => {
    const { rows } = await db.superuser.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'evstation%' ORDER BY rolname",
    );
    const byName = Object.fromEntries(rows.map((row) => [row.rolname, row]));
    expect(byName.evstation_app).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(byName.evstation_owner).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
    expect(byName.evstation_definer).toMatchObject({
      rolsuper: false,
      rolbypassrls: true,
      rolcanlogin: false,
    });

    const ownedTables = await db.superuser.query(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND r.rolname = 'evstation_app'`,
    );
    expect(ownedTables.rowCount).toBe(0);

    const definerTables = await db.superuser.query(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND r.rolname = 'evstation_definer'`,
    );
    expect(definerTables.rowCount).toBe(0);

    const definerFunctions = await db.superuser.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
       WHERE n.nspname = 'app' AND r.rolname = 'evstation_definer'`,
    );
    expect(Number(definerFunctions.rows[0]?.n)).toBeGreaterThanOrEqual(15);
  });

  test('app cannot SET ROLE owner/definer and cannot create schema objects', async () => {
    await expect(db.app.query('SET ROLE evstation_owner')).rejects.toMatchObject({ code: '42501' });
    await expect(db.app.query('SET ROLE evstation_definer')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.app.query('CREATE TABLE app.evil (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('FORCE RLS is enabled on every app table, including for the owner', async () => {
    const { rows } = await db.superuser.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    expect(rows.map((row) => row.relname)).toEqual([
      'audit_log',
      'invitations',
      'membership_sites',
      'memberships',
      'platform_admins',
      'sites',
      'tenants',
      'users',
    ]);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    const asOwner = await db.owner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.tenants',
    );
    expect(Number(asOwner.rows[0]?.n)).toBe(0);
  });
});

describe('fail-closed context', () => {
  test('no actor and no tenant yields zero rows everywhere', async () => {
    await appTx(db, {}, async (client) => {
      for (const table of [
        'tenants',
        'users',
        'memberships',
        'membership_sites',
        'sites',
        'platform_admins',
        'invitations',
        'audit_log',
      ]) {
        expect(await count(client, table)).toBe(0);
      }
    });
  });

  test('actor without tenant sees only their own tenants/memberships/users (switcher), never sites', async () => {
    await appTx(db, { actor: ADMIN_A }, async (client) => {
      const tenants = await client.query<{ slug: string }>('SELECT slug FROM app.tenants');
      expect(tenants.rows.map((row) => row.slug)).toEqual(['acme']);
      expect(await count(client, 'sites')).toBe(0);
      expect(await count(client, 'memberships')).toBe(1);
      expect(await emails(client)).toEqual(['admin@acme.example']);
      expect(await count(client, 'platform_admins')).toBe(0);
      expect(await count(client, 'invitations')).toBe(0);
      expect(await count(client, 'audit_log')).toBe(0);
    });
  });

  test('unknown actor sees nothing (except their own users row)', async () => {
    await appTx(db, { actor: OUTSIDER_ID, tenant: A }, async (client) => {
      for (const table of ['tenants', 'memberships', 'sites', 'membership_sites']) {
        expect(await count(client, table)).toBe(0);
      }
      expect(await emails(client)).toEqual(['outsider@example.com']);
      expect(await count(client, 'audit_log')).toBe(0);
    });
  });

  test('tenant helper is NULL for a non-member, even with a guessed tenant id', async () => {
    await appTx(db, { actor: ADMIN_B, tenant: A }, async (client) => {
      const { rows } = await client.query<{ tenant: string | null }>(
        'SELECT app.tenant_id() AS tenant',
      );
      expect(rows[0]?.tenant).toBeNull();
      expect(await count(client, 'sites')).toBe(0);
    });
  });
});

describe('tenant isolation as app role', () => {
  test('tenant A context only reaches A rows; cross-tenant IDs return zero', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      const tenants = await client.query<{ slug: string }>('SELECT slug FROM app.tenants');
      expect(tenants.rows.map((row) => row.slug)).toEqual(['acme']);
      const sites = await client.query<{ name: string }>(
        'SELECT name FROM app.sites ORDER BY name',
      );
      expect(sites.rows.map((row) => row.name)).toEqual([
        'Acme Depot — Pune',
        'Acme Hub — Bengaluru',
      ]);
      expect(await count(client, 'memberships')).toBe(3);
      expect(await emails(client)).toEqual([
        'admin@acme.example',
        'manager@acme.example',
        'viewer@acme.example',
      ]);

      const byId = await client.query('SELECT * FROM app.sites WHERE id = $1', [SITE_B1]);
      expect(byId.rowCount).toBe(0);
      const updateB = await client.query("UPDATE app.sites SET name = 'hacked' WHERE id = $1", [
        SITE_B1,
      ]);
      expect(updateB.rowCount).toBe(0);
      const deleteB = await client.query('DELETE FROM app.sites WHERE id = $1', [SITE_B1]);
      expect(deleteB.rowCount).toBe(0);

      expect(
        (await fail(client, "INSERT INTO app.sites (tenant_id, name) VALUES ($1, 'sneaky')", [B]))
          .code,
      ).toBe('42501');
      expect(
        (await fail(client, 'UPDATE app.sites SET tenant_id = $1 WHERE id = $2', [B, SITE_A1]))
          .code,
      ).toBe('42501');
      expect(
        (
          await fail(
            client,
            "INSERT INTO app.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'viewer')",
            [B, OUTSIDER_ID],
          )
        ).message,
      ).toMatch(/membership_change_forbidden/);
      expect(
        (
          await fail(client, 'UPDATE app.memberships SET tenant_id = $1 WHERE user_id = $2', [
            B,
            VIEWER_A,
          ])
        ).message,
      ).toMatch(/membership_change_forbidden/);
    });
  });

  test('member rows cannot be re-pointed to another user', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      await expect(
        client.query('UPDATE app.memberships SET user_id = $1 WHERE user_id = $2', [
          OUTSIDER_ID,
          VIEWER_A,
        ]),
      ).rejects.toThrow(/membership_keys_immutable/);
    });
  });

  test('users visibility: tenant_admin sees tenant members, viewer/site manager see only self', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      expect(await emails(client)).toHaveLength(3);
      const platform = await client.query('SELECT * FROM app.users WHERE id = $1', [PLATFORM]);
      expect(platform.rowCount).toBe(0);
    });
    await appTx(db, { actor: VIEWER_A, tenant: A }, async (client) => {
      expect(await emails(client)).toEqual(['viewer@acme.example']);
    });
    await appTx(db, { actor: SITE_MANAGER_A, tenant: A }, async (client) => {
      expect(await emails(client)).toEqual(['manager@acme.example']);
    });
  });
});

describe('site manager / viewer scope', () => {
  test('site manager sees and edits only assigned sites, cannot create/delete', async () => {
    await appTx(db, { actor: SITE_MANAGER_A, tenant: A }, async (client) => {
      const sites = await client.query<{ name: string }>('SELECT name FROM app.sites');
      expect(sites.rows.map((row) => row.name)).toEqual(['Acme Hub — Bengaluru']);

      const ownEdit = await client.query("UPDATE app.sites SET name = 'Renamed' WHERE id = $1", [
        SITE_A1,
      ]);
      expect(ownEdit.rowCount).toBe(1);
      const otherEdit = await client.query("UPDATE app.sites SET name = 'Nope' WHERE id = $1", [
        SITE_A2,
      ]);
      expect(otherEdit.rowCount).toBe(0);

      expect(
        (await fail(client, "INSERT INTO app.sites (tenant_id, name) VALUES ($1, 'new')", [A]))
          .code,
      ).toBe('42501');
      const del = await client.query('DELETE FROM app.sites WHERE id = $1', [SITE_A1]);
      expect(del.rowCount).toBe(0);

      expect(await count(client, 'users')).toBe(1);
      expect(await count(client, 'membership_sites')).toBe(1);
    });
  });

  test('viewer reads all tenant sites but cannot write any', async () => {
    await appTx(db, { actor: VIEWER_A, tenant: A }, async (client) => {
      expect(await count(client, 'sites')).toBe(2);
      const update = await client.query("UPDATE app.sites SET name = 'Nope' WHERE id = $1", [
        SITE_A1,
      ]);
      expect(update.rowCount).toBe(0);
      expect(
        (await fail(client, "INSERT INTO app.sites (tenant_id, name) VALUES ($1, 'new')", [A]))
          .code,
      ).toBe('42501');
      const del = await client.query('DELETE FROM app.sites WHERE id = $1', [SITE_A1]);
      expect(del.rowCount).toBe(0);
    });
  });
});

describe('platform admin', () => {
  test('sees all tenants; no tenant context means no tenant-scoped rows', async () => {
    await appTx(db, { actor: PLATFORM }, async (client) => {
      expect(await count(client, 'tenants')).toBe(2);
      expect(await count(client, 'sites')).toBe(0);
      expect(await count(client, 'memberships')).toBe(4);
    });
    await appTx(db, { actor: PLATFORM, tenant: A }, async (client) => {
      expect(await count(client, 'sites')).toBe(2);
      const inserted = await client.query(
        "INSERT INTO app.sites (tenant_id, name) VALUES ($1, 'Platform-created') RETURNING id",
        [A],
      );
      expect(inserted.rowCount).toBe(1);
    });
  });

  test('platform admin can suspend a tenant; suspended tenant then fails closed', async () => {
    await appTx(db, { actor: PLATFORM, tenant: B }, async (client) => {
      const updated = await client.query(
        "UPDATE app.tenants SET status = 'suspended' WHERE id = $1",
        [B],
      );
      expect(updated.rowCount).toBe(1);
    });
    await db.superuser.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [B]);
    await appTx(db, { actor: ADMIN_B, tenant: B }, async (client) => {
      const { rows } = await client.query<{ tenant: string | null }>(
        'SELECT app.tenant_id() AS tenant',
      );
      expect(rows[0]?.tenant).toBeNull();
      expect(await count(client, 'sites')).toBe(0);
      await expect(
        client.query("INSERT INTO app.sites (tenant_id, name) VALUES ($1, 'blocked')", [B]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('membership guards', () => {
  test('last tenant_admin cannot be demoted or removed', async () => {
    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query('UPDATE app.memberships SET role = $1 WHERE user_id = $2', [
          'viewer',
          ADMIN_A,
        ]);
      }),
    ).rejects.toThrow(/last_tenant_admin/);

    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query('DELETE FROM app.memberships WHERE user_id = $1', [ADMIN_A]);
      }),
    ).rejects.toThrow(/last_tenant_admin/);
  });

  test('demotion is allowed while another admin exists, then the last admin is protected', async () => {
    await appCommit(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      await client.query(
        "INSERT INTO app.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'tenant_admin')",
        [A, OUTSIDER_ID],
      );
    });
    await appCommit(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      const demoted = await client.query(
        "UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1",
        [ADMIN_A],
      );
      expect(demoted.rowCount).toBe(1);
    });
    await expect(
      appTx(db, { actor: OUTSIDER_ID, tenant: A }, async (client) => {
        await client.query("UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1", [
          OUTSIDER_ID,
        ]);
      }),
    ).rejects.toThrow(/last_tenant_admin/);
  });

  test('tenant_admin cannot change tenant status; email edits are not granted', async () => {
    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [A]);
      }),
    ).rejects.toThrow(/tenant_status_forbidden/);

    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query("UPDATE app.users SET email = 'x@example.com' WHERE id = $1", [ADMIN_A]);
      }),
    ).rejects.toMatchObject({ code: '42501' });

    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      const updated = await client.query(
        "UPDATE app.users SET display_name = 'Renamed' WHERE id = $1",
        [ADMIN_A],
      );
      expect(updated.rowCount).toBe(1);
    });
  });
});

describe('last-admin concurrency and platform admin acting', () => {
  test('two admins demoting each other cannot leave the tenant without an admin', async () => {
    await appCommit(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      await client.query(
        "INSERT INTO app.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'tenant_admin')",
        [A, OUTSIDER_ID],
      );
    });

    const app2 = new Client({ connectionString: db.appUrl });
    await app2.connect();
    try {
      await db.app.query('BEGIN');
      await db.app.query("SELECT set_config('app.actor_id', $1, true)", [ADMIN_A]);
      await db.app.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await app2.query('BEGIN');
      await app2.query("SELECT set_config('app.actor_id', $1, true)", [OUTSIDER_ID]);
      await app2.query("SELECT set_config('app.tenant_id', $1, true)", [A]);

      await db.app.query("UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1", [
        OUTSIDER_ID,
      ]);
      const pidRow = await app2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      let outcome: { ok: true } | { ok: false; message: string } | null = null;
      const second = app2
        .query("UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1", [ADMIN_A])
        .then(
          () => {
            outcome = { ok: true };
          },
          (error: Error) => {
            outcome = { ok: false, message: error.message };
          },
        );
      for (let i = 0; i < 100; i++) {
        const activity = await db.superuser.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pidRow.rows[0]?.pid],
        );
        if (activity.rowCount || outcome !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await db.app.query('COMMIT');
      await second;

      let commitError: string | null = null;
      try {
        await app2.query('COMMIT');
      } catch (error) {
        commitError = (error as Error).message;
      }
      expect(commitError).toBeNull();
      if (outcome?.ok === false) {
        expect(outcome.message).toMatch(/last_tenant_admin|membership_change_forbidden/);
      }

      const admins = await db.superuser.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app.memberships WHERE tenant_id = $1 AND role = 'tenant_admin'",
        [A],
      );
      expect(Number(admins.rows[0]?.n)).toBe(1);
    } finally {
      await app2.end();
    }
  });

  test('a platform admin acting in a tenant cannot remove its last admin', async () => {
    await expect(
      appTx(db, { actor: PLATFORM, tenant: A }, async (client) => {
        await client.query("UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1", [
          ADMIN_A,
        ]);
      }),
    ).rejects.toThrow(/last_tenant_admin/);
  });
});

describe('audit log', () => {
  test('append-only and actor-bound', async () => {
    await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
      const inserted = await client.query(
        `INSERT INTO app.audit_log (tenant_id, actor_id, action, outcome)
         VALUES ($1, $2, 'test.action', 'allowed') RETURNING id`,
        [A, ADMIN_A],
      );
      expect(inserted.rowCount).toBe(1);

      expect(
        (
          await fail(
            client,
            `INSERT INTO app.audit_log (tenant_id, actor_id, action, outcome)
             VALUES ($1, $2, 'test.denied', 'denied')`,
            [A, OUTSIDER_ID],
          )
        ).code,
      ).toBe('42501');

      expect(
        (
          await fail(client, "UPDATE app.audit_log SET action = 'tampered' WHERE actor_id = $1", [
            ADMIN_A,
          ])
        ).code,
      ).toBe('42501');
      expect(
        (await fail(client, 'DELETE FROM app.audit_log WHERE actor_id = $1', [ADMIN_A])).code,
      ).toBe('42501');
    });
  });
});

describe('ensure_actor (first login)', () => {
  test('upserts only the caller row from verified claims and syncs email', async () => {
    await appCommit(db, { actor: OUTSIDER_ID }, async (client) => {
      const inserted = await client.query('SELECT * FROM app.ensure_actor($1, $2, true)', [
        OUTSIDER_ID,
        'Outsider2@Example.com',
      ]);
      expect(inserted.rows[0]).toMatchObject({
        id: OUTSIDER_ID,
        email: 'outsider2@example.com',
        email_verified: true,
      });
    });
    const row = await db.superuser.query('SELECT email FROM app.users WHERE id = $1', [
      OUTSIDER_ID,
    ]);
    expect(row.rows[0]?.email).toBe('outsider2@example.com');
  });

  test('rejects mismatched actor, unverified email, and does not touch other users', async () => {
    await expect(
      appTx(db, { actor: OUTSIDER_ID }, async (client) => {
        await client.query('SELECT * FROM app.ensure_actor($1, $2, true)', [
          PLATFORM,
          'platform@evstation.dev',
        ]);
      }),
    ).rejects.toThrow(/actor_mismatch/);

    await expect(
      appTx(db, { actor: OUTSIDER_ID }, async (client) => {
        await client.query('SELECT * FROM app.ensure_actor($1, $2, false)', [
          OUTSIDER_ID,
          'outsider@example.com',
        ]);
      }),
    ).rejects.toThrow(/email_not_verified/);

    const platform = await db.superuser.query('SELECT email FROM app.users WHERE id = $1', [
      PLATFORM,
    ]);
    expect(platform.rows[0]?.email).toBe('platform@evstation.dev');
  });

  test('app role still has no direct INSERT grant on users', async () => {
    await expect(
      appTx(db, { actor: OUTSIDER_ID }, async (client) => {
        await client.query(
          "INSERT INTO app.users (id, email, email_verified) VALUES ($1, 'x@example.com', true)",
          [OUTSIDER_ID],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('guard NULL safety (direct, RLS bypassed via superuser)', () => {
  async function superuserCtx(ctx: { actor?: string; tenant?: string }, fn: () => Promise<void>) {
    await db.superuser.query('BEGIN');
    try {
      if (ctx.actor !== undefined) {
        await db.superuser.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actor]);
      }
      if (ctx.tenant !== undefined) {
        await db.superuser.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenant]);
      }
      await fn();
    } finally {
      await db.superuser.query('ROLLBACK');
    }
  }

  test('guard_membership is closed when the actor has no membership (NULL helpers)', async () => {
    await expect(
      superuserCtx({ actor: OUTSIDER_ID, tenant: A }, async () => {
        await db.superuser.query("UPDATE app.memberships SET role = 'viewer' WHERE user_id = $1", [
          VIEWER_A,
        ]);
      }),
    ).rejects.toThrow(/membership_change_forbidden/);
  });

  test('guard_invitation is closed when the actor has no membership (NULL helpers)', async () => {
    await expect(
      superuserCtx({ actor: OUTSIDER_ID, tenant: A }, async () => {
        await db.superuser.query(
          `INSERT INTO app.invitations (tenant_id, email, role, invited_by, token_hash, expires_at)
           VALUES ($1, 'null@example.com', 'viewer', $2, $3, now() + interval '1 day')`,
          [A, ADMIN_A, token().hash],
        );
      }),
    ).rejects.toThrow(/invitation_forbidden/);
  });

  test('guard_tenant_status is closed for non-platform actors', async () => {
    await expect(
      superuserCtx({ actor: OUTSIDER_ID, tenant: A }, async () => {
        await db.superuser.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [A]);
      }),
    ).rejects.toThrow(/tenant_status_forbidden/);
  });
});

describe('malformed context fails closed', () => {
  test('garbage actor/tenant UUIDs yield no rows instead of an error', async () => {
    await appTx(db, { actor: 'not-a-uuid', tenant: 'also-not-a-uuid' }, async (client) => {
      const { rows } = await client.query<{ actor: string | null; tenant: string | null }>(
        'SELECT app.actor_id() AS actor, app.tenant_id() AS tenant',
      );
      expect(rows[0]).toEqual({ actor: null, tenant: null });
      for (const table of ['tenants', 'sites', 'memberships', 'users', 'audit_log']) {
        expect(await count(client, table)).toBe(0);
      }
    });
  });
});

describe('owner-owned SECURITY DEFINER regression (ADR-0011)', () => {
  test('a definer function owned by evstation_owner is still RLS-filtered', async () => {
    await db.superuser.query(`
      CREATE OR REPLACE FUNCTION public.owner_peek()
      RETURNS SETOF app.tenants
      LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, app, pg_temp
      AS $$ SELECT * FROM app.tenants $$
    `);
    await db.superuser.query('ALTER FUNCTION public.owner_peek() OWNER TO evstation_owner');
    await db.superuser.query('REVOKE ALL ON FUNCTION public.owner_peek() FROM PUBLIC');
    await db.superuser.query('GRANT EXECUTE ON FUNCTION public.owner_peek() TO evstation_app');
    try {
      await appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        const peeked = await client.query('SELECT * FROM public.owner_peek()');
        expect(peeked.rowCount).toBe(0);
        const helper = await client.query<{ tenant: string }>('SELECT app.tenant_id() AS tenant');
        expect(helper.rows[0]?.tenant).toBe(A);
      });
    } finally {
      await db.superuser.query('DROP FUNCTION public.owner_peek()');
    }
  });
});

describe('invitations and accept_invitation', () => {
  test('accepts a valid invitation, creates the user + membership, and marks it used', async () => {
    const { hash } = await insertInvitation('invitee@example.com', 'viewer');
    const invitee = '00000000-0000-4000-8000-0000000000aa';
    const accepted = await accept(invitee, 'invitee@example.com', hash);
    expect(accepted).toMatchObject({ tenant_id: A, role: 'viewer' });

    const membership = await db.superuser.query(
      'SELECT role FROM app.memberships WHERE user_id = $1 AND tenant_id = $2',
      [invitee, A],
    );
    expect(membership.rows[0]?.role).toBe('viewer');
    const invitation = await db.superuser.query(
      'SELECT accepted_at FROM app.invitations WHERE token_hash = $1',
      [hash],
    );
    expect(invitation.rows[0]?.accepted_at).not.toBeNull();

    await appTx(db, { actor: invitee, tenant: A }, async (client) => {
      expect(await count(client, 'sites')).toBe(2);
    });
  });

  test('accept_invitation is trusted under an invitee actor context (no tenant and target tenant)', async () => {
    const noTenantInvite = await insertInvitation('actor-ctx-1@example.com', 'viewer');
    const userId1 = '00000000-0000-4000-8000-0000000000b1';
    await appTx(db, { actor: userId1 }, async (client) => {
      const { rows } = await client.query('SELECT * FROM app.accept_invitation($1, $2, $3, $4)', [
        noTenantInvite.hash,
        userId1,
        'actor-ctx-1@example.com',
        true,
      ]);
      expect(rows[0]?.role).toBe('viewer');
    });

    const targetTenantInvite = await insertInvitation('actor-ctx-2@example.com', 'viewer');
    const userId2 = '00000000-0000-4000-8000-0000000000b2';
    await appTx(db, { actor: userId2, tenant: A }, async (client) => {
      const { rows } = await client.query('SELECT * FROM app.accept_invitation($1, $2, $3, $4)', [
        targetTenantInvite.hash,
        userId2,
        'actor-ctx-2@example.com',
        true,
      ]);
      expect(rows[0]?.role).toBe('viewer');
    });
  });

  test('rejects wrong email, unverified email, expired and suspended-tenant invitations', async () => {
    const { hash } = await insertInvitation('invitee2@example.com', 'viewer');
    await expect(
      accept('00000000-0000-4000-8000-0000000000ab', 'other@example.com', hash),
    ).rejects.toThrow(/invitation_invalid/);
    await expect(
      accept('00000000-0000-4000-8000-0000000000ab', 'invitee2@example.com', hash, false),
    ).rejects.toThrow(/email_not_verified/);

    await db.superuser.query(
      `INSERT INTO app.invitations (tenant_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, 'expired@example.com', 'viewer', $2, $3, now() - interval '1 hour')`,
      [A, ADMIN_A, token().hash],
    );
    const expired = await db.superuser.query<{ token_hash: string }>(
      "SELECT token_hash FROM app.invitations WHERE email = 'expired@example.com'",
    );
    await expect(
      accept(
        '00000000-0000-4000-8000-0000000000ac',
        'expired@example.com',
        expired.rows[0]!.token_hash,
      ),
    ).rejects.toThrow(/invitation_invalid/);

    const suspendedInvite = await insertInvitation('suspended@example.com', 'viewer');
    await db.superuser.query("UPDATE app.tenants SET status = 'suspended' WHERE id = $1", [A]);
    await expect(
      accept('00000000-0000-4000-8000-0000000000ad', 'suspended@example.com', suspendedInvite.hash),
    ).rejects.toThrow(/tenant_suspended/);
  });

  test('site_manager invitation requires a valid site and creates scoped membership', async () => {
    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query(
          `INSERT INTO app.invitations (tenant_id, email, role, site_ids, invited_by, token_hash, expires_at)
           VALUES ($1, 'bad@example.com', 'site_manager', '{}', $2, $3, now() + interval '1 day')`,
          [A, ADMIN_A, token().hash],
        );
      }),
    ).rejects.toThrow(/site_required/);

    const good = await insertInvitation('manager2@example.com', 'site_manager', [SITE_A1]);
    const userId = '00000000-0000-4000-8000-0000000000ae';
    const accepted = await accept(userId, 'manager2@example.com', good.hash);
    expect(accepted.role).toBe('site_manager');
    const scope = await db.superuser.query(
      `SELECT ms.site_id FROM app.membership_sites ms
       JOIN app.memberships m ON m.id = ms.membership_id
       WHERE m.user_id = $1`,
      [userId],
    );
    expect(scope.rows.map((row) => row.site_id)).toEqual([SITE_A1]);

    const crossTenant = await db.superuser.query(
      `INSERT INTO app.invitations (tenant_id, email, role, site_ids, invited_by, token_hash, expires_at)
       VALUES ($1, 'cross@example.com', 'site_manager', ARRAY[$2]::uuid[], $3, $4, now() + interval '1 day')`,
      [A, SITE_B1, ADMIN_A, token().hash],
    );
    expect(crossTenant.rowCount).toBe(1);
    const crossHash = await db.superuser.query<{ token_hash: string }>(
      "SELECT token_hash FROM app.invitations WHERE email = 'cross@example.com'",
    );
    await expect(
      accept(
        '00000000-0000-4000-8000-0000000000af',
        'cross@example.com',
        crossHash.rows[0]!.token_hash,
      ),
    ).rejects.toThrow(/invalid_site_scope/);
  });

  test('rejects already-members and non-hash tokens', async () => {
    const { hash } = await insertInvitation('viewer@acme.example', 'viewer');
    await expect(accept(VIEWER_A, 'viewer@acme.example', hash)).rejects.toThrow(/already_member/);

    await expect(
      appTx(db, { actor: ADMIN_A, tenant: A }, async (client) => {
        await client.query(
          `INSERT INTO app.invitations (tenant_id, email, role, invited_by, token_hash, expires_at)
           VALUES ($1, 'raw@example.com', 'viewer', $2, $3, now() + interval '1 day')`,
          [A, ADMIN_A, 'plaintext-token-not-a-hash'],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('boot preconditions (shared constants)', () => {
  test('seed ids are stable and role passwords are distinct', () => {
    expect(EVSTATION_IDS.acmeTenant).not.toBe(EVSTATION_IDS.betaTenant);
    expect(APP_PASSWORD).not.toBe(OWNER_PASSWORD);
  });
});
