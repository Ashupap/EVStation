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
```

⚠ **Port deviations from upstream CitrineOS** (recorded in ADR-0005): on this
development host something already listens on **8080** and **3000**, so the
CitrineOS HTTP surface is published at **8088** and the Operator UI at
**13000** (only relevant when the `ui` profile is enabled). The OCPP
WebSocket port **8081 keeps the documented upstream value** — the charger
simulator connects to `ws://localhost:8081/<station_id>`, exactly as the
CitrineOS docs describe. Inside the docker network the CitrineOS container
still serves 8080, so CitrineOS's own docs, healthchecks and URLs are
unchanged; only the host mapping differs.

Swagger therefore sits at <http://localhost:8088/docs> on this host.

## Setup

```shell
pnpm install          # exact-pinned install (create hooks too)
pnpm dev:bootstrap    # idempotent: sparse-clones CitrineOS v2.1.0 into third_party/
                      # (verified tag↔commit; failure is intentional and loud)
pnpm dev:stack        # one command: bootstrap check + full stack up (+ health waits)
```

`pnpm dev:stack` creates `infra/compose/.env` from `.env.example` on first run
(dev-only values), then runs `docker compose up -d --wait`. First start pulls
images (≈1 GB) and runs CitrineOS Sequelize migrations; allow a few minutes.

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
  comes from `infra/compose/.env`.
- Our Postgres: `postgresql://evstation@localhost:5432/evstation` (password
  from `infra/compose/.env`)
- CitrineOS's Postgres (read-mostly; used by the smoke test to verify
  records): `postgresql://citrine:citrine@localhost:15432/citrine`
- Hasura console (upstream CitrineOS data API): <http://localhost:8090>
  ⚠ running unauthenticated by upstream's compose default — local only.

## Troubleshooting

- **`git ls-remote` fails in `dev:bootstrap`** — no network to GitHub, or a
  corporate proxy. The bootstrap refuses to proceed on any tag/commit
  mismatch on purpose (see ADR-0004).
- **Port 8080/3000 already in use at `docker compose up`** — expected on this
  host; those ports are not used by the stack (see the port map deviations).
- **CitrineOS unhealthy** — `pnpm dev:stack:logs citrine`; the first boot runs
  migrations, which can take minutes on slow disks.
- **Keycloak reports transport 8080 refusals in healthcheck** — Keycloak
  needs ~30–60 s on first start; `--wait` retries before failing.
