# EVStation — Phase 0 Architecture

One-command local CMS: the pinned upstream CitrineOS stack, our project
template around it, and end-to-end proof tooling. Everything below runs from
a clean clone with `pnpm dev:stack` and is verified by `pnpm health` +
`pnpm smoke`.

```text
                        ┌──────── EVStation (this repo) ─────────┐
 charger / simulator ───▶ OCPP 1.6 ws://localhost:8081/<id>      │
 (tools/simulator)      │                        CitrineOS v2.1.0 │
                        │                        ghcr.io/citrine │
                        │ ocpp-server (DAL → ocpp-db, events)    │
                        └────────────┬───────────────────────────┘
                                     │ Hasura admin GraphQL (secret)
                        ┌────────────▼───────────────────────────┐
                        │ graphql-engine :8090 (metadata inline) │
                        └───┬────────────────────────────────────┘
                            │ tracks
                     ┌──────▼───────┐     ┌──── our PostGIS db ───┐
                     │ ocpp-db (pg16│     │ evstation (placeholder│
                     │ postgis3.5,  │     │ until Phase 1 tables  │
                     │ tenant 1)    │     │ land)                 │
                     └──────────────┘     └───────────────────────┘
        (sidecars: amqp-broker 5672 · keycloak 8180 · citrine-ui 13000 profile)
```

## Layers

1. **Pinned upstream** — `third_party/citrineos-core` is a sparse checkout of
   CitrineOS v2.1.0 (commit `4fd759…`, verified against `git ls-remote`).
   `scripts/bootstrap-citrineos.mjs` re-verifies on every `dev:stack` start
   and refuses to proceed on tag/commit mismatch (ADR-0004).
2. **Vendored infra** — `infra/compose/docker-compose.yml` vendors the
   upstream compose for our dev (exact image pins, 127.0.0.1-only bindings,
   `infra/compose/.env` for secrets/config, host ports per ADR-0007/0009).
   Header notes 1–7 document every deliberate divergence from upstream.
3. **Project template** — pnpm monorepo placeholders in `apps/` (dashboard
   Φ1, api Φ1) & `packages/` (db/csms-adapter/shared Φ2), ESLint 10 /
   Prettier 3 / husky + lint-staged, vitest 5 (ADR-0001–0003).
4. **Proof tooling** — `scripts/health.mjs` (`pnpm health`, TCP/HTTP probes,
   `--json`) and `tools/smoke.mjs` (`pnpm smoke`, full OCPP session with
   fixture upserts via Hasura; ADR-0010 limits smoke to tests).

## Data flow (Phase 0)

- charger/simulator dials `ws://localhost:8081/<id>` with subprotocol
  `ocpp1.6`; profile 0 (no auth) is dev-only (RUNBOOK → "OCPP WebSocket
  exposure").
- CitrineOS persists Boot/transactions/events in `ocpp-db` through its DAL;
  Hasura (:8090) mirrors the same database for admin CRUD; RabbitMQ carries
  module events between CitrineOS processes.
- OCPP 1.6 specifics relied on by the smoke test: CSMS assigns
  `transactionId` server-side; `Authorize` returns `idTagInfo.status`;
  `StartTransaction` fails closed without an `Accepted` idTag row.

## Security posture (Phase 0)

- Surfaced ports bind 127.0.0.1 only; 8080/3000 permanently reserved
  (ADR-0007).
- Hasura admin-secret enforced (compose note 7); secret values live in
  git-ignored `infra/compose/.env`, generated randomly on first creation;
  never printed by scripts.
- Keycloak realm `evstation`: dashboard public client (PKCE, no secret),
  self-registration and password reset disabled, brute-force lockout on.
  Realm import is idempotent via Keycloak `--import-realm`.
- CitrineOS HTTP auth mode is upstream default `localDev` — dev-only per
  ADR-0008 (jwt/Keycloak planned for Phase 2).
- Real-charger hardening (security-profile migration, TLS material,
  `allowUnknownChargingStations` policy) is pre-designed in RUNBOOK →
  "OCPP WebSocket exposure" and deferred (known-issue list).

## Decisions index

Very short pointers — full reasoning in `docs/DECISIONS.md`:

| ADR      | Summary                                                      |
| -------- | ------------------------------------------------------------ |
| ADR-0001 | Node 24.22.2 LTS · vitest 5 · pnpm 10.30.3 exact             |
| ADR-0002 | TypeScript 5.9.3 (typescript-eslint 8 peer range)            |
| ADR-0003 | Exact-version pins, frozen lockfile, `install:ci`            |
| ADR-0004 | CitrineOS v2.1.0 pinned + vendored compose + diff procedure  |
| ADR-0005 | Exact image tags (incl. why Operator UI is not in the stack) |
| ADR-0006 | Keycloak realm `evstation`, dashboard client                 |
| ADR-0007 | Reserved ports (8080/3000, 3200/4000) + dev port set         |
| ADR-0008 | CitrineOS auth modes: `localDev` dev-only; `jwt` (Phase 2)   |
| ADR-0009 | Image support/EOL watch (Hasura, RabbitMQ)                   |
| ADR-0010 | Direct Hasura writes: smoke tests only                       |

## Phase 1 / 2 entry points

- Dashboard (3200) + API (4000) wire up in Phase 1; realm client
  - password flow ready.
- Adapter (`packages/csms-adapter`) talks to CitrineOS via Swagger (add a
  Bearer token factory — ADR-0008) and OCPP routing DB events.
- Tenancy: `DEFAULT_TENANT_ID = 1` today; mapping to real tenants is Phase 1
  planning input.
