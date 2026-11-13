#!/usr/bin/env node
// Phase 0 smoke test (`pnpm smoke`): the end-to-end proof that the stack
// actually accepts a charging session — beyond the TCP-only checks of
// scripts/health.mjs.
//
// 1. Upserts the smoke fixtures through Hasura GraphQL (never duplicates —
//    every row is looked up by its natural key first; that is how station
//    preparation will be formalized for tests until Phase 2 replaces it
//    with CitrineOS's supported operator APIs, ADR-0010).
// 2. Runs the OCPP 1.6 simulator (tools/simulator) with --exit-after-session.
// 3. Verifies in the CitrineOS database that THIS run's transaction exists.
//
// Passing = exit 0. Anything else prints the failing evidence and exits 1.
// Secrets are never printed. Fixture constants are test-only (DECISIONS):
// override them via SMOKE_STATION_ID / SMOKE_ID_TAG / SMOKE_LOCATION_NAME.

import { spawnSync } from 'node:child_process';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');

const APP_STATION_REF = process.env.SMOKE_APP_STATION_REF;
const STATION_ID = process.env.SMOKE_STATION_ID ?? APP_STATION_REF ?? 'cp001';
const ID_TAG = process.env.SMOKE_ID_TAG ?? 'DEADBEEF';
const LOCATION_NAME = process.env.SMOKE_LOCATION_NAME ?? 'Sim Alley';
const TENANT_ID = 1;
const CONNECTOR_ID = 1;

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* handled below */
  }
  return out;
}

const env = readEnv();
const HASURA = 'http://127.0.0.1:8090';
const SECRET = env.HASURA_ADMIN_SECRET;
const problems = [];

function ok(what, detail) {
  console.log(`ok   ${what} — ${detail}`);
}

function fail(what, detail) {
  console.log(`FAIL ${what} — ${detail}`);
  problems.push(`${what}: ${detail}`);
}

function die(msg) {
  console.error(`smoke: ${msg}`);
  process.exit(1);
}

if (!SECRET) {
  die('HASURA_ADMIN_SECRET missing in infra/compose/.env — run `pnpm dev:stack` first.');
}

async function gql(query, variables = {}) {
  const res = await fetch(`${HASURA}/v1/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data;
}

const COORDS = '{"type":"Point","coordinates":[72.8777,19.076]}';
const NOW = 'now()';

async function upsertLocation() {
  const name = LOCATION_NAME;
  const found = await gql(
    `query ($name: String!, $t: Int!) {
    Locations(where: {name: {_eq: $name}, tenantId: {_eq: $t}}) { id } }`,
    { name, t: TENANT_ID },
  );
  if (found.Locations.length > 1)
    throw new Error(`Locations name=${name} not unique (${found.Locations.length} rows)`);
  if (found.Locations.length === 1) return found.Locations[0].id;
  const d = await gql(
    `mutation ($name: String!, $t: Int!) {
    insert_Locations(objects: [{
      name: $name, address: "1 Test St", city: "Mumbai", postalCode: "400001",
      state: "MH", country: "IN", tenantId: $t, coordinates: ${JSON.stringify(COORDS)},
      createdAt: "${NOW}", updatedAt: "${NOW}" }]) {
      returning { id } } }`,
    { name, t: TENANT_ID },
  );
  return d.insert_Locations.returning[0].id;
}

async function upsertStation() {
  const found = await gql(
    `query ($name: String!, $t: Int!) {
    ChargingStations(where: {ocppConnectionName: {_eq: $name}, tenantId: {_eq: $t}}) { id } }`,
    { name: STATION_ID, t: TENANT_ID },
  );
  if (found.ChargingStations.length === 1) return found.ChargingStations[0].id;
  const d = await gql(
    `mutation ($name: String!, $t: Int!) {
    insert_ChargingStations(objects: [{
      ocppConnectionName: $name, isOnline: false, tenantId: $t,
      createdAt: "${NOW}", updatedAt: "${NOW}" }]) {
      returning { id } } }`,
    { name: STATION_ID, t: TENANT_ID },
  );
  return d.insert_ChargingStations.returning[0].id;
}

async function upsertEvse(stationPk) {
  const found = await gql(`query ($s: Int!) { Evses(where: {stationId: {_eq: $s}}) { id } }`, {
    s: stationPk,
  });
  if (found.Evses.length >= 1) return found.Evses[0].id;
  const d = await gql(
    `mutation ($s: Int!, $t: Int!) {
    insert_Evses(objects: [{
      stationId: $s, tenantId: $t, createdAt: "${NOW}", updatedAt: "${NOW}" }]) {
      returning { id } } }`,
    { s: stationPk, t: TENANT_ID },
  );
  return d.insert_Evses.returning[0].id;
}

async function upsertConnector(stationPk, evsePk) {
  const found = await gql(
    `query ($s: Int!, $c: Int!) {
    Connectors(where: {stationId: {_eq: $s}, connectorId: {_eq: $c}}) { id } }`,
    { s: stationPk, c: CONNECTOR_ID },
  );
  if (found.Connectors.length === 1) return found.Connectors[0].id;
  const d = await gql(
    `mutation ($s: Int!, $e: Int!, $c: Int!, $t: Int!) {
    insert_Connectors(objects: [{
      stationId: $s, evseId: $e, connectorId: $c, tenantId: $t,
      createdAt: "${NOW}", updatedAt: "${NOW}" }]) {
      returning { id } } }`,
    { s: stationPk, e: evsePk, c: CONNECTOR_ID, t: TENANT_ID },
  );
  return d.insert_Connectors.returning[0].id;
}

async function upsertAuthorization() {
  const found = await gql(
    `query ($tag: citext!, $t: Int!) {
    Authorizations(where: {idToken: {_eq: $tag}, tenantId: {_eq: $t}}) { id, status, idTokenType } }`,
    { tag: ID_TAG, t: TENANT_ID },
  );
  if (found.Authorizations.length === 1) {
    const a = found.Authorizations[0];
    if (a.status !== 'Accepted') {
      await gql(
        `mutation ($id: Int!) {
        update_Authorizations_by_pk(pk_columns: {id: $id}, _set: {status: "Accepted", updatedAt: "${NOW}"}) { id } }`,
        { id: a.id },
      );
    }
    return a.id;
  }
  const d = await gql(
    `mutation ($tag: citext!, $t: Int!) {
    insert_Authorizations(objects: [{
      idToken: $tag, idTokenType: "ISO14443", status: "Accepted", tenantId: $t,
      createdAt: "${NOW}", updatedAt: "${NOW}" }]) {
      returning { id } } }`,
    { tag: ID_TAG, t: TENANT_ID },
  );
  return d.insert_Authorizations.returning[0].id;
}

function findSimPython() {
  const candidates = [
    process.env.SIM_PYTHON,
    path.join(repoRoot, '.venv/bin/python'),
    'python3',
  ].filter(Boolean);
  for (const py of candidates) {
    const probe = spawnSync(py, ['-c', 'import websockets'], { encoding: 'utf8' });
    if (probe.status === 0) return py;
  }
  return null;
}

function appDatabaseUrl() {
  if (env.DATABASE_URL_MIGRATOR) return env.DATABASE_URL_MIGRATOR;
  const host = env.OUR_DB_HOST ?? 'localhost';
  const port = env.OUR_DB_HOST_PORT ?? '5432';
  const password = env.OUR_DB_PASSWORD;
  if (!password) throw new Error('OUR_DB_PASSWORD missing in infra/compose/.env');
  return `postgres://${encodeURIComponent('evstation')}:${encodeURIComponent(password)}@${host}:${port}/evstation`;
}

async function ensureAppStation() {
  const client = new pg.Client({ connectionString: appDatabaseUrl() });
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT s.id, s.tenant_id, s.site_id, c.id AS connector_id
       FROM app.stations s LEFT JOIN app.connectors c ON c.station_id = s.id AND c.connector_number = 1
       WHERE s.station_ref = $1`,
      [APP_STATION_REF],
    );
    if (existing.rows[0]) return existing.rows[0];
    const scope = await client.query(
      `SELECT t.id AS tenant_id, t.org_code, site.id AS site_id, site.site_code
       FROM app.tenants t JOIN app.sites site ON site.tenant_id = t.id
       WHERE t.slug = 'acme' ORDER BY site.created_at LIMIT 1`,
    );
    const row = scope.rows[0];
    if (!row)
      throw new Error('Acme seed tenant/site missing — run pnpm db:migrate && pnpm db:seed');
    const station = await client.query(
      `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, registration_status)
       VALUES ($1, $2, $3, $4, 'registered') RETURNING id`,
      [row.tenant_id, row.site_id, row.org_code, APP_STATION_REF],
    );
    const stationId = station.rows[0].id;
    const connector = await client.query(
      `INSERT INTO app.connectors (tenant_id, site_id, station_id, connector_number)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [row.tenant_id, row.site_id, stationId],
    );
    return {
      id: stationId,
      tenant_id: row.tenant_id,
      site_id: row.site_id,
      connector_id: connector.rows[0].id,
    };
  } finally {
    await client.end();
  }
}

async function verifyAppIngestion(transactionRef, fixture) {
  const client = new pg.Client({ connectionString: appDatabaseUrl() });
  await client.connect();
  try {
    let session;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await client.query(
        `SELECT s.id, s.status, s.energy_wh, s.ended_at, s.stop_reason
         FROM app.sessions s
         WHERE s.station_id = $1 AND s.csms_transaction_ref = $2`,
        [fixture.id, String(transactionRef)],
      );
      session = result.rows[0];
      if (session?.status === 'completed' && session.ended_at) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!session) {
      fail('app-session', `no app.sessions row for transaction ${transactionRef}`);
      return;
    }
    if (session.status !== 'completed' || !session.ended_at) {
      fail('app-session', `status=${session.status} ended_at=${session.ended_at}`);
      return;
    }
    ok('app-session', `completed, stop_reason=${session.stop_reason}`);
    if (Number(session.energy_wh) > 0) ok('app-energy', `${session.energy_wh} Wh`);
    else fail('app-energy', `energy_wh=${session.energy_wh}`);
    const meters = await client.query(
      'SELECT count(*)::int AS n FROM app.session_meter_values WHERE session_id = $1',
      [session.id],
    );
    if (meters.rows[0].n > 0) ok('app-meter', `${meters.rows[0].n} samples`);
    else fail('app-meter', 'no meter samples');
    const station = await client.query(
      'SELECT reported_vendor, reported_model FROM app.stations WHERE id = $1',
      [fixture.id],
    );
    if (station.rows[0]?.reported_vendor) {
      ok(
        'app-boot',
        `reported ${station.rows[0].reported_vendor}/${station.rows[0].reported_model}`,
      );
    } else {
      fail('app-boot', 'reported_vendor was not recorded');
    }
  } finally {
    await client.end();
  }
}

async function main() {
  try {
    const res = await fetch(`${HASURA}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok('hasura', 'healthz 200');
  } catch (err) {
    fail(
      'hasura',
      `healthz unreachable (${err?.message ?? err}) — is the stack up? try pnpm dev:stack`,
    );
    return;
  }

  let locationId, stationPk, evsePk, connectorId, authId;
  try {
    locationId = await upsertLocation();
    stationPk = await upsertStation();
    evsePk = await upsertEvse(stationPk);
    connectorId = await upsertConnector(stationPk, evsePk);
    authId = await upsertAuthorization();
    ok(
      'fixtures',
      `upserted: location#${locationId} station#${stationPk} evse#${evsePk} connector#${connectorId} authorization#${authId}`,
    );
  } catch (err) {
    fail('fixtures', String(err?.message ?? err));
    return;
  }
  let appFixture;
  if (APP_STATION_REF) {
    try {
      appFixture = await ensureAppStation();
      ok('app-fixture', `station ${APP_STATION_REF} ready`);
    } catch (err) {
      fail('app-fixture', String(err?.message ?? err));
      return;
    }
  }

  const before = await gql(`query { Transactions_aggregate { aggregate { count } } }`);
  const txnCountBefore = before.Transactions_aggregate.aggregate.count;
  ok('pre-run', `Transactions count = ${txnCountBefore}`);

  const py = findSimPython();
  if (!py) {
    fail(
      'simulator',
      'no python with the pinned websockets module — run: python3 -m venv .venv && .venv/bin/pip install -r tools/simulator/requirements.txt (or point SIM_PYTHON at a venv)',
    );
    return;
  }
  const sim = spawnSync(
    py,
    [
      path.join(repoRoot, 'tools/simulator/charger_simulator.py'),
      '--exit-after-session',
      '--id',
      STATION_ID,
      '--id-tag',
      ID_TAG,
    ],
    { encoding: 'utf8', timeout: 180000 },
  );
  process.stdout.write(sim.stdout ?? '');
  process.stderr.write(sim.stderr ?? '');
  if (sim.status !== 0 || sim.error) {
    fail(
      'simulator',
      `exit=${sim.status}${sim.error ? ` (${sim.error})` : ''} — full output above`,
    );
    return;
  }
  ok('simulator', `exit 0 (${py})`);
  const m = (sim.stdout ?? '').match(/"transactionId":\s*(\d+)/);
  if (!m) {
    fail('simulator', 'no transactionId parsed from simulator output');
    return;
  }
  const txnId = m[1];
  ok('this-run', `simulator session used transactionId=${txnId}`);

  const after = await gql(`query { Transactions_aggregate { aggregate { count } } }`);
  const txnCountAfter = after.Transactions_aggregate.aggregate.count;
  if (txnCountAfter !== txnCountBefore + 1) {
    fail(
      'transactions',
      `expected exactly 1 new row (before=${txnCountBefore}, after=${txnCountAfter})`,
    );
  } else {
    ok('transactions', `exactly 1 new row (${txnCountBefore} -> ${txnCountAfter})`);
    const row = await gql(`query { Transactions(order_by: {id: desc}, limit: 1) {
      transactionId, stationId, connectorId, authorizationId, totalKwh, endTime } }`);
    const t = row.Transactions[0];
    const checks = [
      ['transactionId', String(t.transactionId) === txnId, `this run's id (${t.transactionId})`],
      ['stationId', t.stationId === stationPk, `== created station pk ${stationPk}`],
      ['connectorId', t.connectorId === connectorId, `== ${connectorId}`],
      ['authorizationId', t.authorizationId === authId, `== upserted authorization pk ${authId}`],
      ['totalKwh', Number(t.totalKwh) > 0, `energy recorded (${t.totalKwh} kWh)`],
      ['endTime', t.endTime != null, `closed (${t.endTime ?? 'still open'})`],
    ];
    for (const [what, passed, detail] of checks) {
      if (passed) ok(what, detail);
      else fail(what, detail);
    }
    if (APP_STATION_REF && appFixture) await verifyAppIngestion(txnId, appFixture);
  }

  const boots = await gql(
    `query ($s: Int!) { Boots(where: {stationId: {_eq: $s}}) { id, status } }`,
    { s: stationPk },
  );
  if (boots.Boots.length === 1 && boots.Boots[0].status === 'Accepted') {
    ok('boots', `exactly 1 row, status ${boots.Boots[0].status}`);
  } else {
    fail('boots', `expected 1 row status Accepted, got ${JSON.stringify(boots.Boots)}`);
  }

  const dupe = await gql(
    `query ($s: String!, $c: Int!, $t: Int!, $tag: citext!, $loc: String!, $cs: Int!) {
    loc: Locations(where: {name: {_eq: $loc}, tenantId: {_eq: $t}}) { id }
    st: ChargingStations(where: {ocppConnectionName: {_eq: $s}, tenantId: {_eq: $t}}) { id }
    cn: Connectors(where: {stationId: {_eq: $cs}, connectorId: {_eq: $c}}) { id }
    au: Authorizations(where: {idToken: {_eq: $tag}, tenantId: {_eq: $t}}) { id }
    ev: Evses(where: {stationId: {_eq: $cs}}) { id }
  }`,
    {
      s: STATION_ID,
      c: CONNECTOR_ID,
      t: TENANT_ID,
      cs: stationPk,
      tag: ID_TAG,
      loc: LOCATION_NAME,
    },
  );
  const rows = dupe['loc']?.length ?? 0;
  if (
    dupe.loc.length === 1 &&
    dupe.st.length === 1 &&
    dupe.cn.length === 1 &&
    dupe.au.length === 1 &&
    dupe.ev.length >= 1
  ) {
    ok(
      'no-duplicates',
      `fixtures by natural key after the run: locations=${dupe.loc.length} stations=${dupe.st.length} evses=${dupe.ev.length} connectors=${dupe.cn.length} authorizations=${dupe.au.length}`,
    );
  } else {
    fail(
      'no-duplicates',
      `counts: locations=${dupe.loc.length} stations=${dupe.st.length} evses=${dupe.ev.length} connectors=${dupe.cn.length} authorizations=${dupe.au.length}`,
    );
    return `locations=${rows}`; // irrelevant; problems[] drives the exit
  }
}

main().then(
  () => {
    if (problems.length > 0) {
      console.log(
        `smoke: FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'}) exit 1`,
      );
      process.exit(1);
    }
    console.log('smoke: PASS (exit 0)');
  },
  (err) => {
    console.error(`smoke: crashed ${err}`);
    process.exit(1);
  },
);
