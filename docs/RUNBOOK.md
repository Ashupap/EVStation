# Runbook — local development stack

Everything you need to run, verify and reset the Phase 0 dependency stack.
The authoritative decisions behind these commands live in
[DECISIONS.md](./DECISIONS.md).

## Prerequisites

| Tool            | Version     | Notes                                                                    |
| --------------- | ----------- | ------------------------------------------------------------------------ |
| Docker Engine   | ≥ 20.10     | compose v2 CLI built in (`docker compose version`)                       |
| Node.js         | **24.22.2** | exact pin; `.nvmrc` (see ADR-0001). `engine-strict` fails fast otherwise |
| pnpm            | 10.30.3     | exact pin via `packageManager`; Corepack recommended (auto-selected)     |
| Python          | ≥ 3.10      | charger simulator (commit with `tools/simulator`)                        |
| curl (optional) | any         | manual checks against endpoints below                                    |

OS notes: developed and smoke-tested on Linux (x86_64, Ubuntu 22.04).
Windows/macOS should work through Docker Desktop but are unverified.

**Free ports** (all published services bind to `127.0.0.1` only):

```
  5432  our-db (PostGIS 16)          15432  CitrineOS ocpp-db (PostGIS 16)
  8180  Keycloak HTTPS/TLS front              (container 8080)
  8181  Keycloak management port              (container 9000)
  8088  CitrineOS HTTP + Swagger              (container 8080)
  8081  CitrineOS OCPP WebSocket, security profile 0 — NO AUTH (port kept, upstream value)
  8082  CitrineOS OCPP WebSocket, security profile 1 (basic auth)
  8443  CitrineOS OCPP WebSocket, security profile 2 (TLS)
  8444  CitrineOS OCPP WebSocket, security profile 3 (mTLS)
  9229  CitrineOS Node.js debugger
  8090  Hasura GraphQL engine
  5672  RabbitMQ AMQP                15672  RabbitMQ management UI
 13000  CitrineOS Operator UI        (profile `ui`, off by default; container 3000)
  3200  EVStation dashboard (Phase 1)         local dev server / Playwright
  4000  EVStation API service (Phase 1)       local dev server / Playwright
```

⚠ **Reserved ports (permanently, on every dev host using this template) —
never used as defaults anywhere:**

- **8080** and **3000** are reserved for other purposes (they are occupied on
  this dev host as well). The stack's port pre-check (`pnpm dev:stack`) never
  binds them and never checks them; the CitrineOS HTTP surface defaults to
  **8088**, the Operator UI to **13000**, only relevant when the `ui` profile
  is enabled.
- The OCPP WebSocket port **8081 keeps the documented upstream value** — the
  charger simulator connects to `ws://localhost:8081/<station_id>`, exactly
  as the CitrineOS docs describe. Inside the docker network the CitrineOS
  container still serves 8080, so CitrineOS's own docs, healthchecks and
  URLs are unchanged; only host mappings differ.

**Configurable host ports** (in `infra/compose/.env`, defaults below):
`CITRINE_HTTP_HOST_PORT` (8088), `OUR_DB_HOST_PORT` (5432),
`KEYCLOAK_HTTP_HOST_PORT` (8180), `KEYCLOAK_MGMT_HOST_PORT` (8181).
Everything else is deliberately pinned so scripts/docs can rely on it.

**Changing dev ports** (dashboard example): if the dashboard dev port (3200)
changes, change it in _both_ places so it stays consistent:

1. `apps/dashboard/.env.example` (`PORT`) — and your local `.env.local`;
2. the Keycloak realm client in `infra/compose/keycloak/evstation-realm.json`
   (`redirectUris` + `webOrigins` must point at the new `http://localhost:<port>/*`),
   then recreate Keycloak so the realm re-imports:
   `docker compose --project-name evstation --project-directory infra/compose
--env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --force-recreate keycloak`.

The API service (4000) lives only in `apps/api/.env.example` today.

## Setup

```shell
pnpm install          # exact-pinned install (create hooks too)
pnpm dev:bootstrap    # idempotent: sparse-clones CitrineOS v2.1.0 into third_party/
                      # (verified tag↔commit; failure is intentional and loud)
pnpm dev:stack        # one command: bootstrap check + full stack up (+ health waits)
```

`pnpm dev:stack` creates `infra/compose/.env` on first run (follow-up commit a
generates random dev secrets), runs the **port pre-check** (fail-fast, with
the variable to change on conflict), then `docker compose up -d --wait`.
First start pulls images (≈1 GB) and runs CitrineOS Sequelize migrations;
allow a few minutes. The check runs only when the stack is not already
running; ports 8080/3000 are skipped deliberately (reserved).

## Database migrations and policy evidence

Migrations are hand-written SQL in `packages/db/sql`, applied in filename
order. Do not let drizzle-kit own role/policy/trigger DDL.

```shell
pnpm db:migrate                       # apply pending migrations (dev/test)
pnpm db:seed                          # idempotent dev seed for the local stack
pnpm --filter @evstation/db test      # SQL/RLS suite (testcontainers)
```

Policy performance is reproducible with the committed helper (connect as
`evstation_app`, tenant/actor context set transaction-locally):

```shell
node packages/db/scripts/explain-policies.mjs plan sites
node packages/db/scripts/explain-policies.mjs time sites 1000
node packages/db/scripts/explain-policies.mjs full sites
# also: users, memberships; seed instructions in
# docs/evidence/phase1-policy-perf.log
```

Append new plans/timings (and machine specs) to
`docs/evidence/phase1-policy-perf.log`; never rewrite old numbers.

## API service (Phase 1)

```shell
cp apps/api/.env.example apps/api/.env   # fill DATABASE_URL_APP + OIDC settings
pnpm --filter @evstation/api dev         # tsx watch, 127.0.0.1:4000
curl -s localhost:4000/health
curl -s localhost:4000/health/ready
```

The API refuses to boot if `DATABASE_URL_APP` equals the owner/migrator URL or
the connected role is superuser/BYPASSRLS. Tenant-scoped requests use the
verified JWT plus `X-Tenant-Id` (or an `:tenantId` route param); the header is
validated against memberships/platform-admin status. OpenAPI is served at
`/openapi.json` and `/docs`; tests are in `apps/api/test` (`pnpm test`).

## Dashboard service and E2E (Phase 1)

`pnpm dev:stack` creates `apps/dashboard/.env.local` with the generated Keycloak
client secret; fill any missing values from `apps/dashboard/.env.example`.
Database setup and the real-stack tests use the same local stack:

```shell
pnpm db:migrate && pnpm db:seed
pnpm --filter @evstation/dashboard dev                 # http://localhost:3200
pnpm --filter @evstation/dashboard test:e2e           # mocked API; 15+ browser tests
pnpm --filter @evstation/dashboard test:e2e:real      # real Keycloak + API; 3 tests
```

The mocked E2E suite is required in PR CI. The real-stack suite and the
production-like OCPP station-policy test are part of the nightly/dispatch
`smoke` workflow (after fresh + rerun `pnpm smoke`):

```shell
pnpm test:ocpp:production-like   # unregistered station refused; cp001 boots Accepted
```

```shell
gh workflow run smoke.yml --ref <branch>
```

When the API is down, `/login` renders a service-unavailable state rather than
the sign-in form. Production requires `TRUST_PROXY=<hops>` for the dashboard.

## Start / stop

```shell
pnpm dev:stack        # start everything (idempotent)
pnpm dev:stack:down   # stop everything; data volumes kept
pnpm dev:stack:down --volumes   # stop AND wipe Postgres/RabbitMQ data
pnpm dev:stack:logs   # tail stack logs
```

Stopping an individual service: `docker compose --project-name evstation ...
stop citrine` — prefer the pnpm commands unless you have a reason.

### Health check

```shell
pnpm health    # 7 probes: citrine-http/docs, ocpp WS 8081, hasura healthz,
               # keycloak discovery+mgmt /health, our-db/ocpp-db/rabbitmq TCP
```

Passes exit 0 only when everything is up; timeouts are 7 s per probe and
probes are independent of the compose healthchecks. Machine-readable output:
`node scripts/health.mjs --json` (call node directly — `pnpm` prepends a
banner to stdout). Secrets are never printed by the script.

> Note: the DB probes (5432, 15432, 5672) and the WebSocket probe (8081) are
> **TCP reachability only** — they cannot see whether the services hold
> valid schema/state or accept an OCPP session. The **smoke test is the real
> end-to-end proof**: it boots a station, authorizes, starts and stops a
> transaction, and verifies _this run's_ record in ocpp-db.

## Smoke test (Phase 0 end-to-end proof)

```shell
pnpm smoke    # fixtures upsert → OCPP 1.6 session (tools/simulator) → verify transaction
```

Passes (exit 0) only when: the station `cp001` is found/created with its
EVSE/connector and the `DEADBEEF` idTag (status `Accepted`) — **upserted,
never duplicated**; the simulator completes a full session (`--exit-after-session`);
and exactly one transaction row appears for _this run's_
server-assigned `transactionId`, attributed to station/connector/authorization
with recorded kWh and a stop time. Idempotency requirements are part of the
test contract: pass on a fresh volume, twice in a row uncleaned, and after
the simulator has already run (fixture `no-duplicates` check asserts counts
by natural key each time). Fixture data is throwaway (ADR-0010: direct
Hasura writes are smoke-test-only; Phase 2 must use CitrineOS's supported
APIs).

## What runs where

- Swagger / OpenAPI docs: <http://localhost:8088/docs> (CitrineOS HTTP API)
- CitrineOS OCPP WebSocket (no auth, dev): `ws://localhost:8081/<station_id>`
  — security profile 0, station id is the last path segment (CitrineOS v2.1.0
  behavior)
- Keycloak: <http://localhost:8180> — realm `evstation`, client `dashboard`
  (confidential, Authorization Code + PKCE, redirect URIs limited to
  localhost). `pnpm dev:stack` applies the generated client secret from
  `infra/compose/.env` after Keycloak is healthy. Bootstrap admin login
  comes from `infra/compose/.env`. The realm imports with self-registration
  and password-reset off, brute-force lockout on (`bruteForceProtected:
true` — check via the admin API), `sslRequired=external`. Management
  health endpoint `<http://localhost:8181/health>` is enabled through
  `--health-enabled=true` (Quarkus management interface, container 9000).
- Our Postgres: `postgresql://evstation@localhost:5432/evstation` (password
  from `infra/compose/.env`)
- CitrineOS's Postgres (read-mostly; used by the smoke test to verify
  records): `postgresql://citrine:citrine@localhost:15432/citrine`
- Hasura console (upstream CitrineOS data API): <http://localhost:8090>
  — GraphQL API rejects requests without the `x-hasura-admin-secret`
  header; `/healthz` stays open by Hasura's design (accepted upstream
  behavior). The secret lives in `infra/compose/.env`; scripts always read
  it from there; the console asks for it on first load.
  Never expose 8090 beyond 127.0.0.1.
- EVStation dashboard (Phase 1): dev port **3200**; API service (Phase 1): dev
  port **4000** — both reserved now, configured via their app `.env.example`.

## Invitation outbox worker and trusted proxies

The API writes invitation email to `app.email_outbox`; delivery must not block
the HTTP response. Run the worker beside the API with the same
`DATABASE_URL_APP`:

```shell
OUTBOX_MAILER_MODULE=./path/to/mailer.mjs pnpm --filter @evstation/api worker
```

The module must export `createMailer(): Mailer`. `OUTBOX_INTERVAL_MS`,
`OUTBOX_MAX_ATTEMPTS` and `OUTBOX_RETENTION_DAYS` tune retry/pruning. Watch the
worker's JSON error log for `invitation email dispatch failed`; rows remain
retryable until the attempt limit, after which the token is scrubbed.

`TRUST_PROXY` is `false`, a hop count (`1`–`10`), or a comma-separated
proxy/CIDR list (`127.0.0.1,10.0.0.0/8`) for the API. `true` is rejected: the
proxy must be identified explicitly so spoofed `X-Forwarded-For` cannot evade
the IP limit.

The dashboard accepts only a hop count (`1`–`10`) or `false`, takes the
`X-Forwarded-For` entry counted from the right, and ignores all entries to its
left. `false` is allowed in development (one shared `direct` rate-limit bucket)
but **production startup fails unless `TRUST_PROXY` is set**. The dashboard must
not be reachable except through the trusted proxy; the proxy must overwrite
inbound `X-Forwarded-For`. The API's CIDR-list mode is not available in the
dashboard because Next.js does not expose the peer socket address.

## OCPP WebSocket exposure (Phase 0 → real chargers)

Phase 0 binds all OCPP WebSocket ports (`8081/8082/8443/8444`) to
`127.0.0.1` on purpose: only the simulator connects, and profile 0 (no auth,
`allowUnknownChargingStations: true` on 8081) exists solely for testing —
CitrineOS marks that websocket server "development and testing only".

Before real chargers connect, at minimum:

1. **Bind address** — publish the WS ports on the intended interface (load
   balancer / `0.0.0.0` on a hardened host) instead of `127.0.0.1`, and put
   the server behind proper network access controls.
2. **Security profile** — real chargers must use profile 1 (basic auth;
   provision per-station passwords via `POST /commands/setStationPassword`
   at the pin) or profile 2/3 (TLS / mTLS — requires TLS material reachable
   through CitrineOS's `fileAccess`, see websocket-servers JSON). The
   profile-0 server should then be disabled (`allowUnknownChargingStations:
false` at minimum, or removed from the file — see the pinned version's
   config notes).
3. **Unknown-station policy** — production profiles already reject unknown
   charging stations; commission stations deliberately (location → station →
   EVSEs → connectors through our Phase 2 flows, not by hand).
4. Keycloak part of the same change set: ADR-0008 (`jwt` mode instead of the
   `localDev` HTTP API auth).

**This is a Phase 0 known-issue BLOCKER for any non-local deployment** (see
"Known issues" in DECISIONS.md): do not expose this stack beyond a developer
host — shared/staging/production or any network reachable by real chargers —
until steps 1–4 are done and the Phase 1 unknown-station rejection test
passes in CI. Nothing hard-gates a local-only deployment slice.

## Phase 2b ingestion worker

`pnpm worker` consumes the provisioned `evstation.ingest` queue as
`evstation_worker`. It has execute-only database access through
`evstation_ingest` and cannot publish, declare queues or read `messages.ocpp`.
Health is `GET http://127.0.0.1:4100/healthz`.

`pnpm dev:stack` creates the RabbitMQ user, the main/retry queues, the DLX and
the exact bindings (rerun `node scripts/provision-amqp.mjs` if they are
missing). A failed handler is nacked to the retry queue with a 30 s TTL. The retry
queue dead-letters through the default exchange with routing key
`evstation.ingest`, never back through `messages` (that would reach
CitrineOS's own consumers). After five retries the worker writes a `parked`
ingestion ledger row and acks. The committed production definition template is
`infra/compose/rabbitmq/evstation-ingest-definitions.json`; the dev stack
script applies the same definitions idempotently.
Inspect `evstation.ingest`/`evstation.ingest.retry` in the RabbitMQ management
UI at `http://127.0.0.1:15672`. The worker also runs expired pending starts,
offline sweeps, stale-session closure, idTag pseudonymization, monthly
partition creation and retention drops on `WORKER_JOB_INTERVAL_MS` (default
60 s). Tune `STALE_SESSION_SECONDS`, `STATION_OFFLINE_TIMEOUT_SECONDS`,
`ID_TAG_RETENTION_DAYS`, `METER_RETENTION_DAYS`, `STATUS_EVENT_RETENTION_DAYS`
and `INGESTION_LEDGER_RETENTION_DAYS` there. The offline sweeper currently
uses the configured timeout only; until heartbeat-interval tracking lands,
commission chargers with a boot heartbeat interval **<= timeout / 3**.

The 2b end-to-end smoke is:

```shell
SMOKE_STATION_ID=ACME-BLR-001 SMOKE_APP_STATION_REF=ACME-BLR-001 pnpm smoke
```

It creates the app station fixture, runs the simulator and waits for the
worker to finish the session, meter samples and boot fields.

## Troubleshooting

- **`git ls-remote` fails in `dev:bootstrap`** — no network to GitHub, or a
  corporate proxy. The bootstrap refuses to proceed on any tag/commit
  mismatch on purpose (see ADR-0004).
- **Port already in use at `docker compose up`** — the pre-check names the
  port, the variable to change (configurable ports live in
  `infra/compose/.env`), or points to the fixed mapping in
  `infra/compose/docker-compose.yml`. Ports 8080/3000 are reserved and never
  bound by this stack. Nothing is ever killed automatically.
- **CitrineOS unhealthy** — `pnpm dev:stack:logs citrine`; the first boot runs
  migrations, which can take minutes on slow disks.
- **Keycloak reports transport 8080 refusals in healthcheck** — Keycloak
  needs ~30–60 s on first start; `--wait` retries before failing.
- **`pnpm smoke` fails at the simulator step** — a Python with the pinned
  `websockets` module is required. One-off:
  `python3 -m venv .venv && .venv/bin/pip install -r tools/simulator/requirements.txt`
  (pinned exact versions, incl. `websockets==16.1.1`), or point `SIM_PYTHON`
  at an existing interpreter. See `tools/simulator/README.md`.
- **`pnpm smoke` gets `ConcurrentTx` (transactionId 0) at
  `StartTransaction`** — an earlier session was interrupted before
  `StopTransaction` (Ctrl-C mid-smoke), leaving transaction open on
  `cp001/connector 1`. Either stop that transaction (`Transactions.isActive
= true`, no `endTime`; send a `StopTransaction` OCPP call or update it via
  the local Hasura console), or reset state with
  `pnpm dev:stack:down --volumes && pnpm dev:stack` followed by `pnpm smoke`
  (fixtures are recreated automatically).

## SSE operations

`GET /api/events` is the dashboard BFF stream; the API owns `GET /events`.
Metrics are exposed by the API `/metrics` endpoint:
`sse_connections`, `events_notified`, `events_dropped_not_visible`,
`reread_p50_ms`, `reread_p95_ms`, `resyncs`, `backpressure_closes`, and
`notification_queue_usage`.

Limits are 10 streams/user, 250/tenant, and 2,000 per API process; check the
process fd limit before raising them. The API does not replay events: after a
LISTEN reconnect or `Last-Event-ID` it sends `event: resync`; clients refetch.

Deploy behind an ingress that disables buffering and compression for SSE:

```nginx
location = /api/events {
  proxy_pass http://dashboard;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  gzip off;
  chunked_transfer_encoding on;
  add_header X-Accel-Buffering no;
}
```

The app sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`.
Deploy smoke must assert the first SSE chunk arrives within 2 s through the real
ingress.

RabbitMQ queue arguments are immutable: after changing the 5 GiB
`reject-publish` definition, delete `evstation.ingest` and
`evstation.ingest.retry`, then run `node scripts/provision-amqp.mjs` (or apply
`infra/compose/rabbitmq/evstation-ingest-definitions.json`). Ensure no unacked
billing events exist before deleting the queue. `reject-publish` without
publisher confirms can still lose messages; alert on `queue_depth_high` and
consumer lag.
