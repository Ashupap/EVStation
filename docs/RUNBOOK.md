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
  3200  EVStation dashboard (Phase 1)         reserved — not in the stack yet
  4000  EVStation API service (Phase 1)       reserved — not in the stack yet
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

## Start / stop

```shell
pnpm dev:stack        # start everything (idempotent)
pnpm dev:stack:down   # stop everything; data volumes kept
pnpm dev:stack:down --volumes   # stop AND wipe Postgres/RabbitMQ data
pnpm dev:stack:logs   # tail stack logs
```

Stopping an individual service: `docker compose --project-name evstation ...
stop citrine` — prefer the pnpm commands unless you have a reason.

## What runs where

- Swagger / OpenAPI docs: <http://localhost:8088/docs> (CitrineOS HTTP API)
- CitrineOS OCPP WebSocket (no auth, dev): `ws://localhost:8081/<station_id>`
  — security profile 0, station id is the last path segment (CitrineOS v2.1.0
  behavior)
- Keycloak: <http://localhost:8180> — realm `evstation`, client `dashboard`
  (public, PKCE, redirect URIs limited to localhost). Bootstrap admin login
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
  ⚠ protected by `HASURA_ADMIN_SECRET` from `infra/compose/.env` in this
  repository's overlay; scripts always read the secret from that env file.
  Never expose 8090 beyond 127.0.0.1.
- EVStation dashboard (Phase 1): dev port **3200**; API service (Phase 1): dev
  port **4000** — both reserved now, configured via their app `.env.example`.

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

Tracked as hardening output for Phase 5; nothing hard-gates it before a real
deployment slice.

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
