# EVStation — Architecture (Phase 0 baseline, Phase 1 auth/tenancy)

Phase 0 delivers the one-command local CMS: the pinned upstream CitrineOS
stack, our project template around it, and end-to-end proof tooling. Phase 1
(additive) adds Keycloak-backed authentication, a DB-enforced tenant model
and the dashboard/API shells; see "Phase 1" below. Everything runs from a
clean clone with `pnpm dev:stack` and is verified by `pnpm health` +
`pnpm smoke` (plus the Phase 1 test suites).

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

## Phase 1 — authentication, tenancy, RLS

```text
browser ──▶ dashboard :3200 (Next.js BFF)          API :4000 (Fastify)
              │  opaque session cookie (HttpOnly)      ▲  Bearer (server-side only)
              │  tokens in server-side session store   │
              └──────────────▶ Keycloak :8180 ─────────┘
                                realm evstation            │
                                (JWKS, iss, aud)           ▼
                                                   our-db :5432
                                                   evstation_app role
                                                   + RLS (FORCE)
                                                   + app.tenant_id GUC
```

- **Login.** Dashboard uses Authorization Code + PKCE with the confidential
  `dashboard` client (secret from env, applied by the dev seeder). Next.js
  exchanges the code server-side, keeps tokens in a server-side session store
  and gives the browser only an opaque session cookie (httpOnly,
  SameSite=Lax, Secure in production).
- **API auth.** The API verifies JWTs against Keycloak JWKS (signature,
  issuer, audience `evstation-api`, expiry) and maps `sub` → `users`.
- **Tenant context.** One request = one DB transaction. The API sets only
  `app.actor_id` and the validated `app.tenant_id` (from route param or
  `X-Tenant-Id`, never body/query). Role, site scope and platform-admin
  status are derived in the database from `memberships`,
  `membership_sites` and `platform_admins` (ADR-0011). Missing or
  foreign tenant context yields zero rows.
- **Authorization.** A single `authorize(user, action, resource)` module
  implements the PRD §7 matrix and site scope; routes are declared in one
  registry used by the fail-closed isolation suite.
- **Isolation proof.** SQL-level tests connect as `evstation_app` (no
  BYPASSRLS, not the table owner, FORCE RLS) and prove zero cross-tenant
  rows; the API isolation suite iterates the route registry.

### Audit semantics (for API authors)

- Audit rows are **write-only from the request path**: `evstation_app` has
  `INSERT`/`SELECT` grants but no `UPDATE`/`DELETE`, and an append-only
  trigger rejects both even for the table owner/superuser. Insert without
  `RETURNING`: PostgreSQL applies the `audit_log_select` policy to returned
  rows, and only tenant admins may read them. Viewers and site managers can
  record allowed events but must not ask for the row back.
- Write audit rows **in the same transaction** as the mutation they describe,
  so an audit failure rolls the mutation back. For a denied attempt the
  request transaction may roll back; write that row in a separate
  transaction after the response is decided (ADR-0011).
- `tenant_id` is the tenant the action belongs to, or `NULL` for a denied
  attempt with a forged/unknown tenant and for platform-global actions. The
  attempted tenant goes in `details` (e.g. `{"attempted_tenant":"…"}`), never
  in `tenant_id`.
- `actor_id` must equal `app.actor_id()`; the API must never accept it from
  the payload. Include `action`, `resource_type`, `resource_id`, `outcome`
  (`allowed`/`denied`), optional `details`, and the per-request
  `request_id`. Never log tokens, invitation hashes/secrets, or raw headers.
- Offboarding is soft-delete (membership removal / tenant suspension); Phase 1
  has no hard-delete or purge endpoint. Audit history is retained.

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
| ADR-0011 | DB roles + RLS; API sets only actor/tenant, DB derives role  |
| ADR-0012 | API JWT auth, single-tx context, `authorize()`, error shape  |
| ADR-0013 | Dashboard confidential client + server-side session + CSRF   |
| ADR-0014 | Invitations (hashed tokens) and append-only audit log        |

## Phase 1 / 2 entry points

- Dashboard (3200) + API (4000) wire up in Phase 1; realm client is
  confidential (PKCE, secret from env via the dev seeder).
- Adapter (`packages/csms-adapter`) talks to CitrineOS via Swagger (add a
  Bearer token factory — ADR-0008) and OCPP routing DB events.
- Tenancy: Phase 1 introduces real tenants in our DB; mapping CitrineOS's
  `DEFAULT_TENANT_ID` to our tenant model is Phase 2 planning input.
