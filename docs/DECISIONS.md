# Decisions (ADR log)

Short-form ADRs: context → decision → consequences. Newest entries may appear
under the newest section number; numbers are stable and never reused.

Test-only constants are flagged where relevant:

- `cp001` (station / charge point id) and `DEADBEEF` (RFID idTag) are
  **test-only fixtures** for the Phase 0 smoke test. They must never be used in
  a real environment. Our production station naming convention is planned for
  Phase 2.

## Runtime and tooling

### ADR-0001: Run on Node 24 LTS · vitest 5 · pnpm 10 exact pin

- **Context.** The PRD (docs/PRD.md, section 4) originally said "Node 20+ LTS".
  Node 20 reached end-of-life in April 2026, and the current test-runner
  generation (vitest 5) requires Node `^22.12 || ^24 || >=26`. CitrineOS
  v2.1.0 itself requires Node 24.16+ for source builds (we consume its
  published images, but staying on the same LTS reduces drift).
- **Decision.** Our monorepo runtime is **Node 24 LTS, exact-pinned
  24.22.2** (`.nvmrc`, `package.json` `engines`, and the CI Node version in
  `.github/workflows`, which reads `.nvmrc`). Vitest is pinned to the latest
  stable 5.x at adoption time (`5.0.5`). pnpm is exactly pinned via
  `packageManager` (`pnpm@10.30.3`).
- **Consequences.** "20+" from the PRD is superseded by an exact-higher floor;
  the PRD runtime line was updated accordingly. Environments running Node 20/22
  must upgrade before running this repo's scripts.

### ADR-0002: TypeScript pinned to 5.9.3 (not 7.x)

- **Context.** TypeScript 7.0.2 is the current `latest` on npm
  (2026-11-02), but typescript-eslint 8.72.1 declares peer support only for
  `typescript >=4.8.4 <6.1.0`.
- **Decision.** Pin TypeScript **5.9.3** (newest 5.x) so that
  `typescript-eslint` type-aware linting stays inside supported ranges.
- **Consequences.** Revisit when typescript-eslint publishes support for
  TypeScript ≥7; then bump TypeScript and re-pin. Until then, language
  features from TS 6/7 are unavailable to this repo.

### ADR-0003: Reproducible installs — exact versions and frozen lockfile

- **Context.** Contract rules: no dependency drift between machines; CI must
  test what got committed; hooks may be bypassed locally, so CI must run the
  same checks.
- **Decision.** (1) All dependency versions are recorded **exact** (no `^`
  ranges; `.npmrc` sets `save-exact=true`, and existing ranges were rewritten
  to exact). (2) `pnpm-lock.yaml` is committed. (3) CI installs with
  `pnpm install --frozen-lockfile` (root script `install:ci`), failing the
  build if the lockfile is out of sync with `package.json`. (4) `packageManager`
  is an exact pnpm version, so Corepack and CI agree on the package manager.
- **Consequences.** Upgrade PRs must also commit the regenerated
  `pnpm-lock.yaml`; CI blocks unnoticed drift. `.npmrc` sets
  `engine-strict=true`, so installs and scripts fail fast on unsupported Node
  versions instead of only warning.

## Infrastructure

### ADR-0004: CitrineOS pinned to v2.1.0, vendored compose, upstream checkout

- **Context.** Contract rules forbid guessing CitrineOS ports/paths; CitrineOS
  "API paths and ports differ between versions"; releases appear in
  citrineos-core (the landing repo `citrineos/citrineos` has no releases).
  The upstream compose binds 0.0.0.0 and floats `:latest`.
- **Decision.**
  - Pin **CitrineOS `v2.1.0` = `4fd7599b91c2fb6e6065e7c9b94be69880cced27`**
    (2026-10-21). Verified during commit 4 that upstream `git ls-remote`
    resolves `refs/tags/v2.1.0^{}` to that exact commit — all three sources
    (upstream remote, local clone peel, `git describe`) agree. The pin is
    machine-readable in `infra/compose/citrineos.json` and enforced by
    `scripts/bootstrap-citrineos.mjs`, which **stops with an error** on any
    mismatch (per instructions: never continue on a drifted pin).
  - `third_party/citrineos-core` is a git-ignored **sparse checkout** of the
    pinned tag (`--filter=blob:none --depth 1 --branch v2.1.0`); no CitrineOS
    source is copied into this repository.
  - `infra/compose/docker-compose.yml` **vendors** the upstream services
    (`citrine`, `amqp-broker`, `ocpp-db`, `graphql-engine`, plus profile-gated
    `citrine-ui`) with documented deviations only: exact image pins; ports
    bound to 127.0.0.1; HTTP published at host 8088 and the UI at host 13000
    (ports 8080/3000 are permanently reserved — see ADR-0007); `ocpp-db` on
    host 15432 (our DB owns 5432); named data volumes instead of upstream
    repo-relative bind mounts; certificate-authority integrations left off.
    Consistency with upstream is reviewed at every CitrineOS upgrade.
  - At the pinned version the OCPP 1.6 entry path is:
    `ws://localhost:8081/<station_id>` (security profile 0,
    `allowUnknownChargingStations: true`); stations need pre-registered
    Location → ChargingStation → EVSE → Connector → Authorization records
    (per `apps/operator-ui` README at the pin), and `StartTransaction`
    requires the idTag to exist exactly once in `Authorizations` with status
    `Accepted`.
- **Consequences.** Upgrades = change `citrineos.json` + re-diff the vendored
  services against the new upstream compose (procedure in ADR-0007,
  support/EOL watch → ADR-0009) + regenerate smoke fixtures. The 8080→8088
  host mapping is the standing default for local dev (ADR-0007); other hosts
  may map 8080 back (upstream value) if that port is genuinely free there.

### ADR-0005: Exact-pinned dev-stack image tags

| Component                                   | Image (tag notes via ADR-0003)                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CitrineOS server                            | `ghcr.io/citrineos/citrineos-server:v2.1.0`                                                                                                                                                 |
| CitrineOS Operator UI (optional ui profile) | `ghcr.io/citrineos/citrineos-operator-ui:v2.1.0`                                                                                                                                            |
| Our database (and CitrineOS's own)          | `postgis/postgis:16-3.5` — PostGIS 16 exact line used by upstream for `ocpp-db`; same image for ours keeps one supported geospatial stack (station discovery / trip planning need it later) |
| Keycloak                                    | `keycloak/keycloak:26.8.1` — newest 26.x.y on Docker Hub at adoption (2026-11-02)                                                                                                           |
| Hasura                                      | `hasura/graphql-engine:v2.40.3.cli-migrations-v3` (upstream pin kept)                                                                                                                       |
| RabbitMQ                                    | `rabbitmq:3.13.7-management` (newest exact 3.x patch released upstream)                                                                                                                     |

- **Consequences.** Every image upgrade is a deliberate, reviewable commit.
  Keycloak runs `start-dev` (dev profile) with an embedded non-persistent
  database and imports the committed realm on each start; Phase 1 moves
  Keycloak onto our Postgres and out of dev mode.

### ADR-0006: Keycloak realm "evstation" — public `dashboard` client only

- **Context.** PRD Phase 0: self-hosted Keycloak with a committed realm.
- **Decision.** Committed realm JSON (`infra/compose/keycloak/
evstation-realm.json`) declares realm `evstation` with one public client
  `dashboard`: Authorization Code + PKCE enforced (`pkce.code.challenge.method: S256`
  attribute), no client secret, `directAccessGrantsEnabled: false`,
  redirect URIs limited to `http://localhost:3200/*` and web origin
  `http://localhost:3200` (dashboard dev port, ADR-0007; Phase 1 may extend
  to other localhost ports explicitly). Realm import via `--import-realm`
  mounted at `/opt/keycloak/data/import/`. Bootstrap admin credentials come
  from `infra/compose/.env` (never committed). No users are seeded in
  Phase 0.
- **Consequences.** Phase 1 adds a realm seed script (users, realm roles,
  claims) and moves Keycloak to `start` (production mode) backed by our
  Postgres.

### ADR-0008: CitrineOS API authentication at the pin — `localDev` is dev-only

- **Context.** At v2.1.0, `CITRINEOS_AUTH_MODE` selects CitrineOS's HTTP API
  authentication (apps/ocpp-server README at the pin). The stack currently
  runs the default **`localDev`** mode: tokens are minted by the server
  itself from an ephemeral startup keypair, handed out by `POST /dev/token`
  (roles requested in the body; flat claim paths required). `localDev` is
  refused automatically when `env=production`, and the default `localBypass`
  mode disables enforcement entirely — both must never see a shared
  environment.
- **Decision.**
  - `localDev` (+ `POST /dev/token`) and `localBypass` are **local-dev only**
    (127.0.0.1-bound stack). The adapter and scripts may use `POST /dev/token`
    locally while that is the configured mode; no code may assume these
    endpoints exist outside local dev.
  - Shared/staging/production must run `auth.mode: jwt`: tokens are Bearer
    JWTs verified against the Identity Provider's JWKS with an exact `issuer`
    match, configurable claim paths (`rolesClaim`, `tenantClaim`) and an
    optional `audience`; signing-key curl-mode is implicit; role grants are
    resolved by name from the roles seed file (`roles-seed.json`, re-read on
    an interval).
  - **Phase 2 expectation (moderately sure, to be confirmed in Phase 1
    planning):** bind CitrineOS to Keycloak — `jwt` mode with
    `jwksUri=https://<keycloak>/realms/evstation/protocol/openid-connect/certs`,
    `issuer=https://<keycloak>/realms/evstation`, and realm roles carried in
    mapped claims. How CitrineOS _tenants_ map onto our tenant model (the
    claim → tenant id question) is not yet decided — Phase 1 outputs the
    mapping, Phase 2 wires it; explicitly unresolved here.
  - **Upgrade items scored against this ADR** (tracked until fixed):
    (1) before anything beyond localhost is exposed, switch off `localDev`
    and set `jwt` with real Keycloak (gate: Phase 5 hardening, or earlier if
    the stack becomes multi-host); (2) the operator-UI `keycloak-auth-provider`
    exists in the upstream pin, but its Hasura/JWT claims wiring is untested
    by us.
- **Consequences.** Nothing depends on `/dev/token` or on token _content_
  beyond role names today; Phase 2's adapter only needs a Bearer token
  factory behind one interface. ADRs gain a checklist item: verify
  `CITRINEOS_AUTH_MODE` in any environment definition.

### Test-only fixtures

- `cp001` (station id) and `DEADBEEF` (RFID idTag) are smoke-test fixtures
  chosen to match the upstream operator-ui/EVerest defaults (reduces setup
  risk for throwaway data). **They are test-only and must never be used in a
  real environment.** Both are configurable via env vars/flags in the smoke
  test and simulator. Phase 2 defines the production station naming
  convention.

### Simulator & station-preparation issues (commit 6/7 record)

- OCPP 1.6J `StopTransactionResponse` has **no `status` field**; the
  simulator asserts a CallResult arriving at all (plus `StartTransaction`
  asserts a server-assigned positive integer `transactionId`). No protocol
  bug — a spec fact.
- CitrineOS assigns `transactionId` **server-side**; the persisted
  `Transactions.transactionId` is stored as a **string** (the smoke test
  compares `String(t.transactionId) === txnId`), while the 1.6 wire value
  is an int.
- `Authorizations.idToken` is **CITEXT**; Hasura GraphQL variables touching
  it must be typed `citext!`, not `String!` (validation-failed otherwise).
- The Hasura inserts need explicit `coordinates` (PostGIS, NOT NULL),
  `createdAt`/`updatedAt` (`"now()"`) — the Sequelize defaults in the model
  are _not_ backed by DB defaults in the vendored migrations.
- An unregistered station still boots (`CITRINEOS_OCPP_UNKNOWNCHARGERSTATUS`
  defaults to `Accepted`), but `Authorize`/`StartTransaction` fail without
  an `Authorizations` row — fixtures must exist before the session.
- The smoke test's first draft queried a `Transactions.meterStop` column
  that does not exist (meter stop lives on `StopTransactions`); corrected to
  verify `totalKwh > 0` on the actual `Transactions` row instead.
- Otherwise **no further protocol issues, bugs or work-arounds** were hit in
  the simulator or the station preparation; the passing session log is
  reproduced in the Phase 0 final report (unchanged upstream behavior).

### ADR-0010: Hasura station-preparation is smoke-test-only

- **Context.** Phase 0's smoke test creates/updates fixtures (Location →
  ChargingStation → EVSE → Connector → Authorization) directly through the
  Hasura admin GraphQL endpoint. That is an internal edge of CitrineOS's DAL
  (Hasura is not its supported management surface) and requires the admin
  secret.
- **Decision.** Direct Hasura writes are acceptable **for local dev fixing
  and the Phase 0 smoke test only**. The Phase 2 adapter (and any operator
  flow we ship) must go through CitrineOS's supported APIs — the Swagger
  HTTP API (`:8088`, auth per ADR-0008) and OCPP messaging — never direct
  database writes through Hasura or SQL. The smoke test may keep using
  Hasura because its fixture data is throwaway and CI-scoped; a proof-point
  is tracked for Phase 2: re-create the same fixtures through the supported
  operator/data API and delete this ADR's exception.
- **Consequences.** No product or adapter code is allowed to import the
  Hasura client; `tools/smoke.mjs` is the only sanctioned writer besides
  CitrineOS itself. Audit item for Phase 2 review: confirm no adapter code
  touches port 8090.

### Known issues (Phase 0 close-out list)

1. Authenticated OCPP ports are **not yet exercised**: profile 1 basic
   auth (`:8082`) and TLS/mTLS (`:8443/:8444`) — Connectors/charging flows
   ran on profile 0 only. Defer to Phase 1 wiring of the first real
   charging slice.
2. Image EOL watch items are tracked in ADR-0009 (Hasura v2.40 line
   outside Hasura's supported LTS lines; RabbitMQ 3.13 OSS support has
   ended — both pinned for reproducibility, upgrade spec'd for hardening).
3. Hasura `/healthz` is open (no secret) by upstream design; 8090 is bound
   to 127.0.0.1 only in this stack (graph X-Real-IP not exposed).
4. CitrineOS HTTP auth defaults to `localDev` (`/dev/token`) — ADR-0008
   tracks the swap to `jwt`/Keycloak before any shared environment.
5. The dashboard/API packages are placeholders: ports 3200/4000 reserved
   (ADR-0007) but no code wired yet (Phase 1).
6. The OCPP WebSocket server runs with `allowUnknownChargingStations: true`
   at the pin; production tightening is documented in the RUNBOOK's
   "OCPP WebSocket exposure" section.

### ADR-0007: Dev port map — defaults, configurability, reserved ports

- **Context.** Ports 8080 and 3000 are permanently reserved on the
  development hosts using this template (occupied there for good; never
  defaults anywhere in this repository). Runtime ports must be stable for
  scripts and docs, but a few surface host ports should be adjustable in
  restricted environments.
- **Decision.** Host-port defaults (configurable via `infra/compose/.env`,
  pre-checked by `pnpm dev:stack`):
  - `CITRINE_HTTP_HOST_PORT` = **8088** → CitrineOS HTTP + Swagger
    (container stays 8080; OCPP WebSocket ports keep upstream 8081/8082).
  - `OUR_DB_HOST_PORT` = **5432** → our PostGIS database.
  - `KEYCLOAK_HTTP_HOST_PORT` = **8180** (container 8080) and
    `KEYCLOAK_MGMT_HOST_PORT` = **8181** (container 9000).
  - EVStation **dashboard dev port = 3200**, EVStation **API dev port =
    4000** — _reserved from Phase 0_ (set in the app `.env.example` files;
    not in the compose stack yet). Changing the dashboard port requires
    changing the Keycloak realm redirect URIs/web origins too (documented in
    the RUNBOOK "Changing dev ports").
  - Deliberately fixed (so scripts/docs can rely on them): OCPP WebSocket
    8081/8082/8443/8444, debugger 9229, ocpp-db 15432, Hasura 8090,
    RabbitMQ 5672/15672, Operator UI 13000 (only behind the `ui` profile).
- **Consequences.** Any host port conflict now fails fast _before_ compose
  runs, naming the port, the variable to change, and the file to change it
  in. Nothing is ever killed automatically. 8080/3000 remain untouched by
  this stack on every host.

- **Vendored-compose diff procedure (run at every CitrineOS upgrade).** In
  `/tmp/opencode/citrineos-core` (or a fresh clone of the new pin):
  `git diff <old-pin> <new-pin> -- docker-compose.yml` to see upstream's own
  changes; then `git diff <old-pin-ref>:docker-compose.yml
infra/compose/docker-compose.yml` for ours-vs-new; repeat for
  `apps/ocpp-server/src/assets` and `apps/ocpp-server/db/hasura-metadata`
  (the vendored copies in `infra/compose/` and
  `third_party/citrineos-core/`). Every deliberate divergence we add
  (ports, our-db service, Keycloak block, env-file switches) must still be
  present and documented after the refresh — the upgrade commit lists
  applied deltas in its message; nothing new is absorbed silently.

### ADR-0009: Pinned-images support status & EOL watch (2026-11 snapshot)

- **Context.** Phase 0 pins exact image tags (ADR-0005); upgrades of
  CitrineOS itself (ADR-0004) will re-evaluate these. Recorded snapshot of
  upstream support status as of 2026-11-02, plus watch items; verify dates
  again at each upgrade rather than trusting this table blindly.
- **Snapshot.**
  - `ghcr.io/citrineos/citrineos-server:v2.1.0` — actively developed
    upstream (release train continues at the citrine repo). Fine.
  - `postgis/postgis:16-3.5` — PostgreSQL 16 supported to ~Nov 2028;
    PostGIS 3.5 stable. Fine.
  - `keycloak/keycloak:26.8.1` — current 26.x line (community, latest
    minor is maintained). Fine; track 27.x adoption at upgrade time.
  - `hasura/graphql-engine:v2.40.3.cli-migrations-v3` — **watch item**:
    v2.40 shipped mid-2024 and is outside Hasura's supported LTS lines
    (v2.45 LTS EOL Dec 2027, v2.50 LTS EOL Dec 2028; current releases are
    v2.51.x). Upstream pins it; we keep the pin for reproducibility, but a
    shared environment needs a Hasura on a supported LTS line — upgrade
    spec'd in Phase 5 hardening (metadata lives in citrine-db; standard
    Hasura upgrade procedure applies).
  - `rabbitmq:3.13.7-management` — **watch item**: OSS community support
    for 3.13.x ended Sep 2024; newer 3.13 patches are commercial-only (3.13
    line itself runs to Dec 2029 under paid support). 4.2.x is the current
    OSS LTS. Upstream floats `rabbitmq:3-management` (currently still 3.13.x
    on Docker Hub — re-verify at upgrade). Queue persistence needs nothing
    exotic, so keep the exact pin for dev; broker upgrade ride along with
    CitrineOS's own.
  - Toolchain: Node 24.22.2 LTS (maintenance after Oct 2026; support to
    ~Apr 2028, matching ADR-0001); pnpm 10.30.3 (track the latest pnpm
    major upstream publishes — support policy not pinned down in writing,
    so re-check rather than assume).
- **Consequences.** The two watch items (Hasura, RabbitMQ) are recorded as
  upgrade considerations in Phase 5; dev containers are not exposed, so no
  free-security-update gap bites us in Phase 0. Any upgrade changes this
  ADR with a dated snapshot line.
