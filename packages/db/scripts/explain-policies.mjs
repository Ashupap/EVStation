// Reproducible EXPLAIN helper for the RLS policy performance fix (0014).
//
// Seed a large tenant first (example in docs/evidence/phase1-policy-perf.log),
// then:
//   node packages/db/scripts/explain-policies.mjs plan sites
//   node packages/db/scripts/explain-policies.mjs time sites 1000
//   node packages/db/scripts/explain-policies.mjs full sites
//   node packages/db/scripts/explain-policies.mjs page sites
//   EXPLAIN_ACTOR=site_manager node ... page memberships
//   (also: users, memberships)
//
// EXPLAIN_ACTOR: tenant_admin (default), site_manager, viewer, platform, or a
// literal user UUID.
import { Client } from 'pg';
import { dbCredentials } from './lib.mjs';
import { SEED_IDS } from './seed.mjs';
const ACTORS = {
  platform: SEED_IDS.platformAdmin,
  tenant_admin: SEED_IDS.acmeAdmin,
  site_manager: SEED_IDS.acmeSiteManager,
  viewer: SEED_IDS.acmeViewer,
};
const actor = ACTORS[process.env.EXPLAIN_ACTOR] ?? process.env.EXPLAIN_ACTOR ?? ACTORS.tenant_admin;
const c = dbCredentials();
const app = new Client({ connectionString: c.app });
await app.connect();
await app.query('BEGIN');
await app.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
await app.query("SELECT set_config('app.tenant_id', $1, true)", [SEED_IDS.acmeTenant]);
const mode = process.argv[2] ?? 'plan';
const table = process.argv[3] ?? 'sites';
const limit = Number.parseInt(process.argv[4] ?? '50', 10);
const pages = {
  sites: `SELECT id, name, status FROM app.sites ORDER BY name, id LIMIT ${limit}`,
  memberships: `SELECT id, tenant_id, user_id, role FROM app.memberships ORDER BY user_id, id LIMIT ${limit}`,
  users: `SELECT id, email, display_name FROM app.users ORDER BY display_name, id LIMIT ${limit}`,
};
const sql =
  mode === 'plan'
    ? `EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM app.${table}`
    : mode === 'time'
      ? `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM (SELECT 1 FROM app.${table} LIMIT ${limit}) s`
      : mode === 'page'
        ? `EXPLAIN (ANALYZE, BUFFERS) ${pages[table] ?? pages.sites}`
        : `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM app.${table}`;
const start = Date.now();
const plan = await app.query(sql);
console.log(`\n=== ${mode} ${table} (${Date.now() - start}ms) ===`);
console.log(plan.rows.map((r) => r['QUERY PLAN']).join('\n'));
await app.query('ROLLBACK');
await app.end();
