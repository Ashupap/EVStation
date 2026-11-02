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
  services against the new upstream compose (procedure in ADR-0008) +
  regenerate smoke fixtures. The 8080→8088 host mapping is the standing
  default for local dev (ADR-0007); other hosts may map 8080 back (upstream
  value) if that port is genuinely free there.

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

### Test-only fixtures

- `cp001` (station id) and `DEADBEEF` (RFID idTag) are smoke-test fixtures
  chosen to match the upstream operator-ui/EVerest defaults (reduces setup
  risk for throwaway data). **They are test-only and must never be used in a
  real environment.** Both are configurable via env vars/flags in the smoke
  test and simulator. Phase 2 defines the production station naming
  convention.

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
