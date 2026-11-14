# EVStation

An EV charging Central Management System (CMS) for India, built on top of
[CitrineOS](https://github.com/citrineos/citrineos-core) (open-source OCPP 1.6 & 2.0.1 CSMS).

[![ci](https://github.com/Ashupap/EVStation/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Ashupap/EVStation/actions/workflows/ci.yml)
[![smoke](https://github.com/Ashupap/EVStation/actions/workflows/smoke.yml/badge.svg?branch=main)](https://github.com/Ashupap/EVStation/actions/workflows/smoke.yml)

- Language: TypeScript (Node 24 LTS) across a pnpm monorepo
- Auth: Keycloak (OIDC)
- Database: PostgreSQL 16 + PostGIS (separate from CitrineOS's own database)
- Local dev: Docker Compose (our DB, Keycloak, CitrineOS stack) + OCPP 1.6J simulator

## Current status

**Phase 0 (repository & infrastructure bootstrap) — complete.** Tagged
`phase-0-complete`.

**Phase 1 (authentication, tenants and row-level security) — complete.**
Tagged `phase-1-complete`; see [docs/PHASE1_ACCEPTANCE.md](docs/PHASE1_ACCEPTANCE.md).

**Phase 2a/2b (station registry, CitrineOS adapter, AMQP ingestion worker,
tenant-scoped session/event reads) — complete.** Tagged `phase-2a-complete`
and `phase-2b-complete`.

**Phase 2c (SSE realtime events, Phase 2 documentation and acceptance) —
complete.** Tagged `phase-2c-complete`; the live-latency and N-stream load
evidence is on the `phase2c-evidence` branch, not yet merged. See
[docs/PHASE2_ACCEPTANCE.md](docs/PHASE2_ACCEPTANCE.md),
[docs/API_EVENTS.md](docs/API_EVENTS.md), and
[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).

Proven in Phase 0:

- One-command local stack (`pnpm dev:stack`) — 7 services, all healthy; CitrineOS
  pinned to v2.1.0 (`4fd7599b…`, verified, vendored sparse checkout).
- `pnpm health` — HTTP/tool-level probes for CitrineOS, Hasura, Keycloak
  (realm + management), OCPP WS, and all datastores.
- OCPP 1.6J simulator (`tools/simulator/`) — Boot → Authorize → Start → MeterValues
  → Stop → Available, with hard assertions (full session:
  [`docs/evidence/phase0-simulator-session.log`](docs/evidence/phase0-simulator-session.log)).
- `pnpm smoke` — end-to-end and **idempotent**: prepares fixture rows via Hasura,
  runs the simulator, verifies exactly one new `Transactions` row per run (reruns
  and a pre-run standalone simulator session were exercised).
- CI — `ci.yml` runs lint/format/typecheck/tests on PRs and main; `smoke.yml`
  runs the full stack + smoke twice on manual dispatch and nightly.

Proven in Phase 1:

- Keycloak Authorization Code + PKCE with a confidential dashboard client; the
  browser receives only an opaque `HttpOnly` session cookie and never sees API
  or OIDC tokens.
- Fastify API JWT verification (signature, issuer, audience, expiry), tenant
  context from verified claims/header, centralized authorization and the PRD §7
  role matrix.
- PostgreSQL RLS with a non-owner, non-BYPASSRLS app role, forced policies,
  transaction-scoped actor/tenant context, and an isolation suite that walks the
  route registry.
- Invitations (hashed tokens, fragment-only accept URL), append-only audit log,
  outbox email stub, CSRF-protected BFF mutations, fixed-window login/callback
  throttling, idle/absolute server-side session expiry and RP-initiated logout.
- Required PR CI plus a nightly/dispatch real Keycloak + API + dashboard E2E
  smoke run, including a production-like OCPP overlay that refuses an
  unregistered station while the commissioned fixture still boots.

Known issues:

- Dashboard sessions, login transactions and rate-limit buckets are in-process.
  A restart ends sessions and a multi-replica deployment needs a shared store.
- `TRUST_PROXY` on the dashboard is a hop count and is mandatory in production;
  the dashboard must not be directly reachable except through the trusted proxy.
- Platform-admin impersonation / "acting as" is explicitly deferred (ADR-0018).
- Invitation email delivery remains a logged/dev outbox stub until Phase 5.
- The OCPP profile-0 exposure and CitrineOS `localDev` HTTP auth remain
  non-local-deployment blockers from Phase 0 (ADR-0008, RUNBOOK).

## Quickstart

Prerequisites: Node 24.22.2 (see `.nvmrc`), pnpm 10.30.3 (`corepack enable`),
Docker with Compose v2, and Python 3.10+ for the simulator.

```bash
pnpm install
pnpm dev:stack        # verifies the CitrineOS pin, generates .env secrets, starts the stack
pnpm health           # all services should report ok
pnpm test             # unit tests
```

Run a charging session against the local CSMS:

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/simulator/requirements.txt
pnpm smoke            # fixtures + simulator + verification, idempotent (safe to rerun)
```

Tear down (add `--volumes` to reset databases):

```bash
pnpm dev:stack:down
```

Notes:

- `infra/compose/.env` is generated on first run with random local secrets and is
  git-ignored; never commit it.
- Ports 8080/3000 are permanently reserved and never bound (ADR-0007). Host ports
  are listed in the [RUNBOOK](docs/RUNBOOK.md#ports).
- Nothing outside the test fixtures is seeded; `cp001` / `DEADBEEF` are test-only.

## Repository layout (as built)

```
apps/api               Fastify BFF-facing API (Phase 1, port 4000)
apps/dashboard         Next.js BFF operator dashboard (Phase 1, port 3200)
packages/db            Schema, migrations, RLS policies, seeds (Phase 1)
packages/csms-adapter  Only module allowed to talk to CitrineOS (Phase 1)
packages/shared        Shared types, Zod schemas, constants
scripts                bootstrap-citrineos, dev-stack, health
tools/simulator        OCPP 1.6J charger simulator (Python, pinned deps)
tools/smoke.mjs        End-to-end smoke test (fixtures + simulator + assertions)
infra/compose          Vendored CitrineOS compose (pinned) + our services + realm
docs                   PRD, ARCHITECTURE, DECISIONS (ADRs), RUNBOOK, evidence
.github/workflows      ci.yml (PR checks) + smoke.yml (dispatch/nightly)
```

## Commands

| Command                                            | What it does                                 |
| -------------------------------------------------- | -------------------------------------------- |
| `pnpm dev:stack`                                   | Verify pin, generate `.env`, start the stack |
| `pnpm dev:stack:down [--volumes]`                  | Stop the stack (optionally wipe volumes)     |
| `pnpm dev:stack:logs`                              | Follow service logs                          |
| `pnpm health` / `health:json`                      | Probe all services (human / machine output)  |
| `pnpm smoke`                                       | Idempotent end-to-end smoke test             |
| `pnpm lint` / `lint:fix`                           | ESLint                                       |
| `pnpm format` / `format:check`                     | Prettier                                     |
| `pnpm typecheck`                                   | Per-package + root TypeScript                |
| `pnpm test` / `test:watch`                         | Vitest unit/integration suites               |
| `pnpm test:db`                                     | SQL-level RLS/migration suite                |
| `pnpm --filter @evstation/dashboard test:e2e`      | Mocked browser E2E                           |
| `pnpm --filter @evstation/dashboard test:e2e:real` | Real Keycloak + API E2E                      |

## Documentation

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Phase 1 acceptance matrix](docs/PHASE1_ACCEPTANCE.md)
- [Phase 2 acceptance matrix](docs/PHASE2_ACCEPTANCE.md)
- [Realtime event schema](docs/API_EVENTS.md)
- [Known issues](docs/KNOWN_ISSUES.md)
- [Decisions (ADRs) & known issues](docs/DECISIONS.md)
- [Runbook](docs/RUNBOOK.md) — ports, health, first station bring-up, smoke, troubleshooting
- [Simulator](tools/simulator/README.md)
