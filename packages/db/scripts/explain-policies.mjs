// Reproducible EXPLAIN helper for the RLS policy performance fix (0014).
//
// Seed a large tenant first (example in docs/evidence/phase1-policy-perf.log),
// then:
//   node packages/db/scripts/explain-policies.mjs plan sites
//   node packages/db/scripts/explain-policies.mjs time sites 1000
//   node packages/db/scripts/explain-policies.mjs full sites
//   (also: users, memberships)
import { Client } from 'pg';
import { dbCredentials } from './lib.mjs';
import { SEED_IDS } from './seed.mjs';
const c = dbCredentials();
const app = new Client({ connectionString: c.app });
await app.connect();
await app.query('BEGIN');
await app.query("SELECT set_config('app.actor_id', $1, true)", [SEED_IDS.acmeAdmin]);
await app.query("SELECT set_config('app.tenant_id', $1, true)", [SEED_IDS.acmeTenant]);
const mode = process.argv[2] ?? 'plan';
const table = process.argv[3] ?? 'sites';
const sql =
  mode === 'plan'
    ? `EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM app.${table}`
    : mode === 'time'
      ? `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM (SELECT 1 FROM app.${table} LIMIT ${process.argv[4] ?? 1000}) s`
      : `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM app.${table}`;
const start = Date.now();
const plan = await app.query(sql);
console.log(`\n=== ${mode} ${table} (${Date.now() - start}ms) ===`);
console.log(plan.rows.map((r) => r['QUERY PLAN']).join('\n'));
await app.query('ROLLBACK');
await app.end();
