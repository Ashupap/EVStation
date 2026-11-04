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

Proven in this phase:

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

Phase 1 (first vertical slice: dashboard + API + adapter) is next; see
`docs/ARCHITECTURE.md` for entry points and `docs/DECISIONS.md` for open questions.

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
apps/api               Fastify API service (placeholder, port 4000 reserved)
apps/dashboard         Next.js operator dashboard (placeholder, port 3200 reserved)
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

| Command                           | What it does                                 |
| --------------------------------- | -------------------------------------------- |
| `pnpm dev:stack`                  | Verify pin, generate `.env`, start the stack |
| `pnpm dev:stack:down [--volumes]` | Stop the stack (optionally wipe volumes)     |
| `pnpm dev:stack:logs`             | Follow service logs                          |
| `pnpm health` / `health:json`     | Probe all services (human / machine output)  |
| `pnpm smoke`                      | Idempotent end-to-end smoke test             |
| `pnpm lint` / `lint:fix`          | ESLint                                       |
| `pnpm format` / `format:check`    | Prettier                                     |
| `pnpm typecheck`                  | Per-package + root TypeScript                |
| `pnpm test` / `test:watch`        | Vitest                                       |

## Documentation

- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decisions (ADRs) & known issues](docs/DECISIONS.md)
- [Runbook](docs/RUNBOOK.md) — ports, health, first station bring-up, smoke, troubleshooting
- [Simulator](tools/simulator/README.md)
