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
- **Phase 1 amendment — dependency age gate.** A new dependency or upgrade may
  only be pinned after verifying on the npm registry that the exact version
  exists and was published **at least 14 days** before adoption (`npm view
<pkg> version` + `npm view <pkg> time --json`). Versions younger than that
  are replaced with the previous stable release, or the pin waits. The
  verification (package → version → publish date) is recorded in the upgrade
  commit message.

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
6. **BLOCKER for any non-local deployment:** the OCPP WebSocket server runs
   with `allowUnknownChargingStations: true` at the pin, and profile 0
   (no auth) is bound on `:8081`. Any deployment that is not a developer
   laptop (shared/staging/production, or any host reachable by real chargers)
   must not ship until this is flipped to `false` with commissioned stations
   and an authenticated profile (basic auth or TLS/mTLS) — see the RUNBOOK's
   "OCPP WebSocket exposure" section for the hardening checklist.
   **Phase 1 test:** a CI job boots a production-like OCPP config
   (`allowUnknownChargingStations: false`, profile 1+ only), attempts a
   WebSocket connection with an unregistered station id and asserts the
   connection is refused (upgrade rejected/closed, no BootNotification
   accepted), then asserts a commissioned station still connects and boots
   `Accepted`.

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

## Phase 1 — authentication, tenancy, RLS

### ADR-0011: Database roles, RLS and per-request tenant context

- **Context.** Phase 1 must make tenant isolation a database guarantee, not an
  API convention (PRD §5.3, Phase 1). The app must not be able to bypass RLS
  even with a mis-scoped query. Helper functions used inside RLS policies
  cannot read `memberships`/`platform_admins` as the app role without either
  recursion (policy → helper → policy) or RLS filtering their own lookups,
  and a `SECURITY DEFINER` function owned by the (NOBYPASSRLS, FORCE-RLS)
  table owner is still subject to RLS — proven by a test before the fix
  (`packages/db/test` "owner-owned definer is blocked").
- **Decision.**
  - Roles: `evstation` (container superuser; bootstrap + dev/test seed only),
    `evstation_owner` (LOGIN, NOSUPERUSER, NOBYPASSRLS; owns tables and
    migrations), `evstation_app` (LOGIN, NOSUPERUSER, NOBYPASSRLS, owns
    nothing; DML grants only), `evstation_definer` (NOLOGIN **BYPASSRLS**;
    owns **only** the audited `SECURITY DEFINER` helper/accept functions).
  - **The API sets exactly two GUCs**, transaction-locally:
    `app.actor_id` and `app.tenant_id`. It does **not** set role, site scope
    or platform-admin flags — a bug there would otherwise become an RLS
    bypass. The database derives the rest:
    - `app.actor_id()` / `app.tenant_id()` normalize unset settings to NULL;
    - `app.is_platform_admin()` reads `platform_admins` for the actor;
    - `app.actor_role()` reads the actor's membership in `app.tenant_id()`;
    - `app.actor_site_ids()` reads `membership_sites` for that membership;
    - `app.tenant_id()` returns **NULL** unless the actor is a member of the
      requested tenant or a platform admin, and NULL for suspended tenants
      (fail-closed: `tenant_id = NULL` matches no rows).
  - All helpers are `SECURITY DEFINER`, owned by `evstation_definer`, with
    `SET search_path = pg_catalog, app, pg_temp`, `REVOKE ALL ... FROM
PUBLIC`, `GRANT EXECUTE` to `evstation_app` only. They are `STABLE`.
  - `FORCE ROW LEVEL SECURITY` on every tenant table; app role has no DDL,
    no `TRUNCATE`, no ownership, cannot `SET ROLE` the owner; API boot fails
    if the app URL equals the owner/migrator URL or the connected role has
    `rolbypassrls = true`.
  - Invitation acceptance runs through one `SECURITY DEFINER` function owned
    by `evstation_definer` (see ADR-0014); the invitee has no tenant context
    yet, so ordinary policies cannot admit the membership insert.
  - Policies: `tenants` SELECT = active tenant, platform admin, **or any
    tenant the actor is a member of** (tenant switcher; the tenant directory
    stays global for platform admins); every other tenant-scoped read requires
    the tenant GUC, including for platform admins: `memberships` SELECT = own
    rows + selected-tenant rows for managers; `users` SELECT = self +
    selected-tenant members for managers (viewers/site managers cannot
    enumerate users); `sites` = selected-tenant read for admins/viewers, site
    scope for site managers, writes as per the matrix; `invitations` and
    `audit_log` selected-tenant managers only. A platform admin with no tenant
    GUC therefore sees the tenant directory and its own user row, but no
    tenant-scoped rows. `audit_log` inserts require `actor_id =
app.actor_id()` with no UPDATE/DELETE grants plus an append-only trigger
    backstop.
  - Membership safety rules are enforced in the database as well as in
    `authorize()`: `UNIQUE(user_id, tenant_id)`; deleting/demoting the last
    `tenant_admin` is rejected; granting a role above the actor's own is
    rejected (platform admins exempt).
  - `membership_sites(membership_id, site_id)` replaces a `uuid[]` column so
    site deletion cannot leave dangling scope entries (FKs, `ON DELETE
CASCADE`); a deferred constraint trigger requires site managers to have
    at least one site.
  - `tenants` UPDATE is intentionally limited to the `status` column. Renaming
    a tenant (or changing its slug) requires a platform-admin-only
    `SECURITY DEFINER` function if the Phase 1 API needs it; do not widen the
    column grant.
  - `users`/`memberships` describe **operator staff** only. EV driver
    accounts are a separate concern (Phase 6) and must not be stored in
    `users`/`memberships`; driver login must not receive an operator
    membership.
  - **New tenant tables** must use the 0014 pattern: every zero-argument
    `app.*` stable helper appears only inside `(SELECT app.helper())`, inline
    membership probes where an index exists, FORCE RLS, and explicit
    least-privilege grants. Require an EXPLAIN before merge at 1M rows for the
    table's common list query (the 100k-row evidence in
    `docs/evidence/phase1-policy-perf.log` is the baseline).
  - **Offboarding is soft-delete only in Phase 1.** Deactivate/suspend rather
    than delete `users`/`tenants`; there is no purge endpoint. The append-only
    audit trigger blocks hard deletes that would orphan audit history, so a
    future retention/erasure feature needs an explicit, audited design (and
    likely a separate archive).
- **Consequences.** Hand-written SQL migrations are the source of truth for
  roles, grants, policies, triggers and functions; drizzle-kit's generated
  diffs are **not** allowed to own or regenerate policy/role DDL (guarded by
  `drizzle.config.ts` generating only table diffs into designated files and a
  test asserting the policy/role migration files are untouched). The seed
  runs as the container superuser (dev/test only, refused when
  `NODE_ENV=production`). Denied (403) attempts are audited in a **separate
  transaction** because the request transaction may roll back. A fully
  compromised API process can still set GUCs — RLS protects against API bugs,
  not a hostile server; this trust boundary is accepted.
- **Migration execution.** Schema/function DDL runs through `pnpm db:migrate`
  connected as the container superuser (`evstation`), while every schema
  object is explicitly owned by `evstation_owner` (`SET ROLE` in the SQL
  file). The owner role stays `NOBYPASSRLS` and is never granted membership
  in `evstation_definer`, so it cannot `SET ROLE` into the BYPASSRLS role;
  superuser is required only to create the definer-owned functions and the
  roles themselves. The API runtime never uses the superuser or owner URL.
  BYPASSRLS bypasses policies but **not** table privileges, so the definer
  role receives explicit `SELECT` grants (plus the specific `INSERT`/`UPDATE`
  grants `accept_invitation` needs); the `SECURITY DEFINER` helpers therefore
  cannot be used to reach tables the definer was not granted.

### ADR-0012: API authentication and tenant resolution

- **Context.** Phase 1 needs Keycloak-issued JWTs verified independently of
  the dashboard and a single place that decides capabilities.
- **Decision.**
  - Verification with `jose`: remote JWKS, exact issuer/audience, signature,
    `exp`/`nbf`; anything else → 401 with the standard error shape. Realm
    `dashboard` client gets an audience mapper for `evstation-api`.
  - Principal resolution and context setting happen in **one transaction**:
    `BEGIN` → set `app.actor_id` from the verified `sub` → JIT-upsert the
    `users` row → load memberships/platform-admin/tenant rows (RLS permits
    self/own-tenant reads) → validate the requested tenant (route param, else
    `X-Tenant-Id`; never body/query) → set `app.tenant_id` → handlers →
    `COMMIT`. A suspended tenant yields 403 at this step.
  - `authorize(user, action, resource)` is the only capability logic
    (table-driven from PRD §7, site-scope aware). Routes declare their
    capability in the central registry; the isolation suite fails closed if a
    tenant-scoped route is missing coverage.
  - `email_verified: true` is required for invitation acceptance; tokens
    lacking it are rejected for that action.
  - Errors: `{ error: { code, message, details? } }`; cross-tenant by-ID
    access surfaces as 404 (no existence leak), capability failures as 403.
  - Endpoint surface: `POST/GET /tenants`, `PATCH /tenants/:id`,
    `POST/GET /tenants/:id/invitations`, `DELETE
/tenants/:id/invitations/:invitationId`, `POST /invitations/accept`,
    `GET/PATCH /me`, `GET/POST /sites`, `PATCH /sites/:id`, `GET /users`,
    `PATCH /users/:id/role`, `GET /health`, `GET /health/ready`, `/docs`,
    `/openapi.json`.
- **Consequences.** The dashboard is a BFF: the browser never holds a token
  and never calls the API directly. Platform-admin access outside a tenant is
  limited to the tenants surface; acting inside a tenant requires explicit
  selection and is audited.

### ADR-0013: Dashboard session and OIDC client

- **Context.** The dashboard is a server-rendered operator tool; a stolen
  encrypted cookie holding a refresh token would be a long-lived credential.
  PRD Phase 1 requires the shell only.
- **Decision.**
  - **Confidential Keycloak client** `dashboard` with PKCE (S256). The client
    secret is read from env (`OIDC_CLIENT_SECRET`, generated into
    `infra/compose/.env` on first run and applied to Keycloak by the dev
    seeding script via the admin API) and is never committed. Fallback to
    public+PKCE only if the confidential flow proves impractical; the ADR
    must then record why.
  - **Server-side session store:** the cookie carries only an opaque random
    session ID (`HttpOnly`, `SameSite=Lax`, `Secure` in production,
    `Path=/`). Access/refresh/ID tokens and the active tenant live in the
    server-side store; logout deletes the session and revokes the refresh
    token at Keycloak (RFC 7009). The Phase 1 store is in-process behind a
    `SessionStore` interface (single instance documented; Phase 5 swaps in a
    shared store). Absolute session lifetime and refresh-token rotation are
    enforced by the store.
  - **CSRF:** `SameSite=Lax` plus an Origin/Host check on every state-changing
    BFF request (POST/PATCH/DELETE), covered by tests.
  - Tokens never appear in browser JavaScript, `localStorage`,
    `sessionStorage`, `document.cookie`, or BFF response bodies; Playwright
    asserts all of these.
- **Consequences.** Restarting the dashboard invalidates dev sessions
  (acceptable Phase 1). The API stays bound to localhost and is not exposed
  to browsers.

### ADR-0014: Invitations and audit log

- **Context.** Phase 1 needs stored invitations with an accept flow, and
  non-forgeable audit entries for security-relevant actions.
- **Decision.**
  - Invitation tokens are 32 random bytes (base64url), shown once; only a
    SHA-256 hash is stored (`invitations.token_hash`, unique). Tokens are
    never logged; the dev email stub writes no token (a non-production API
    response field returns the accept URL for local testing only).
  - Accept requires the authenticated user's **verified** email to match the
    invitation (citext), a pending/unexpired invitation, and runs the
    audited `SECURITY DEFINER` `app.accept_invitation(token_hash, actor,
email)` owned by `evstation_definer` (atomic: membership insert +
    `membership_sites` + invitation status + audit).
  - Invitations require an existing Keycloak account with a verified email;
    there is no self-registration. Dev seeding creates test accounts.
  - Audit rows are append-only (no UPDATE/DELETE grants + trigger backstop),
    stamp `actor_user_id`, active tenant, an `acting_as_platform_admin`
    marker, action, resource, and redacted metadata. Denied (403) attempts
    are written from a separate transaction.
- **Consequences.** Keycloak realm: `verifyEmail: true`; self-service email
  changes are disabled so the invitee email cannot be re-pointed.

### ADR-0015: Trusted definer context for invitation acceptance

- **Context.** `accept_invitation` is the one write path that runs before the
  invitee has a membership. If the API sets `app.actor_id` for audit (as it
  should), the membership guard saw "actor is not a tenant_admin" and raised
  `role_above_actor`, rejecting a legitimate acceptance.
- **Decision.** Guard triggers are `SECURITY INVOKER` and skip actor/role
  checks only when `current_user = 'evstation_definer'`. `evstation_definer`
  is NOLOGIN, is not granted to `evstation_app` or `evstation_owner`, and is
  reachable only by executing a `SECURITY DEFINER` function owned by it, so
  the app role cannot forge the marker via GUCs or `SET ROLE`. The acceptance
  function itself validates the token hash, verified email, tenant status,
  inviter authority, role and site scope (ADR-0014 and 0018).
- **Consequences.** Any future definer-owned write function inherits this
  trust and must perform its own authorization; guards must not be made
  definer-owned again without auditing that path. Direct guard tests run as
  the superuser (RLS bypassed, `current_user` not the definer) so they still
  exercise the actor checks.

### ADR-0016: Keycloak email changes and local email collisions

- **Context.** The API keys users by Keycloak `sub` but stores a unique,
  case-insensitive email for invitation matching. If an operator enables
  self-service email changes, or a person deletes and recreates a Keycloak
  account with an email still held by an old local row, the next request can
  try to move an email that already belongs to another `app.users.id`.
- **Decision.**
  - Keycloak self-service email editing remains disabled in Phase 1
    (ADR-0014). The API still treats a verified email change from an
    administrative Keycloak update as authoritative for that same `sub`:
    `app.ensure_actor` updates the row on the next request.
  - The local email column stays unique. If the new email is already attached
    to a different `sub`, the unique violation is deliberately mapped to
    `409 EMAIL_IN_USE`; the API does not merge accounts, memberships or audit
    history automatically.
  - Resolution is administrative and explicit: an operator must decide which
    Keycloak identity owns the person, free or change the conflicting email
    (or deactivate the stale local identity), then let the intended `sub`
    retry. A recreated Keycloak account is a new identity, not a silent
    takeover of the old membership set.
  - Invitation acceptance uses the same verified, case-insensitive email
    comparison. It never re-points an existing user row by email; a mismatch
    or collision fails closed.
- **Consequences.** Email collisions surface as an actionable `409`, not a
  login loop or cross-account merge. Supporting self-service email changes in
  a later phase requires an explicit identity-link/merge workflow, not just
  enabling the Keycloak setting.

### ADR-0017: Invitation mail outbox and post-commit dispatch

- **Context.** Sending invitation mail inside the database transaction can
  deliver a message for an invitation that the transaction later rolls back.
  It also loses the message if the process exits immediately after commit.
- **Decision.**
  - `app.email_outbox` stores the recipient, fragment accept URL, expiry and
    dispatch state in the same transaction as the invitation. It is covered by
    RLS and allows only tenant managers to read/insert; the API role can update
    only `dispatched_at` and `last_error`.
  - The mailer runs only after the transaction commits. Successful delivery
    marks `dispatched_at`; delivery failure leaves the row pending with a
    generic `last_error` and logs only the outbox ID, never the accept URL.
  - Dispatch is at-least-once. A crash after delivery but before the mark can
    resend, which is preferable to losing an invitation in Phase 1.
- **Consequences.** Pending rows are visible for operational follow-up, and a
  rollback can never send mail. A later retry worker can consume the pending
  rows without changing the invitation transaction.

### ADR-0018: Platform-admin impersonation is out of Phase 1 scope

- **Context.** Platform administrators can see cross-tenant metadata for
  support and operations. Letting them "act as" a tenant user would require
  a second identity context, explicit consent where required, durable
  impersonation records, and careful audit attribution.
- **Decision.** Phase 1 does not implement platform-admin acting-as or any
  user impersonation. Platform admins use their own identity; tenant-scoped
  actions still require a membership in the selected tenant. The
  `acting_as_platform_admin` audit marker is set when a platform admin uses
  their own identity to act inside a selected tenant; it is not an
  impersonation marker.
- **Consequences.** Support cannot reproduce a tenant user's exact
  permissions through impersonation in Phase 1. Adding it later requires a
  new ADR, short-lived impersonation grants, clear UI indicators, and audit
  events that preserve both actor and subject identities.

### ADR-0019: Dashboard client IPs use an explicit trusted-proxy hop count

- **Context.** The dashboard rate-limits login and callback attempts and forwards
  the end-user IP to the API. Taking the leftmost `X-Forwarded-For` entry lets a
  client spoof the bucket/forwarded IP. With no trust setting, every direct
  client shares one bucket, so an unauthenticated flood can lock out everyone.
  Next.js route handlers do not expose the peer socket address, so the dashboard
  cannot apply the API's proxy/CIDR source check.
- **Decision.**
  - `TRUST_PROXY` on the dashboard is `false` or an integer hop count (`1`–`10`),
    matching the API's hop-count form. `true` is rejected.
  - With a hop count, the dashboard selects the `X-Forwarded-For` entry counted
    from the right (`addresses[length - hops]`), ignoring spoofed entries to its
    left. Missing, short or non-IP chains fall back to the shared `direct`
    bucket and are not forwarded to the API.
  - Production startup fails unless `TRUST_PROXY` is set. The deployment must
    prevent direct access to the dashboard and the trusted edge proxy must
    overwrite inbound `X-Forwarded-For`.
  - Development may keep `TRUST_PROXY=false`; the shared bucket is accepted
    there.
- **Consequences.** Spoofed leftmost XFF no longer bypasses or poisons the
  limit, and clients behind one proxy get separate buckets. The dashboard
  cannot verify the peer against a CIDR list until it runs behind a custom
  server or proxy that supplies the peer address; that is deliberately out of
  Phase 1. The rate limiter remains in-process (see known issues).

## Known issues (Phase 1 close-out)

1. **In-process dashboard state.** OIDC login transactions, sessions and
   rate-limit buckets live in the dashboard process. Restarting the dashboard
   ends all sessions, and multiple replicas do not share sessions or limits.
   Phase 2 needs a shared session/limit store (for example Redis) or sticky
   single-replica deployment.
2. **Dashboard trusted proxy.** Only hop-count mode is supported because Next.js
   does not expose the peer socket. Production requires `TRUST_PROXY` and a
   proxy-enforced network boundary; there is no CIDR-list source check in the
   dashboard.
3. **Platform-admin impersonation.** "Acting as" another user is deferred
   (ADR-0018). Platform admins act with their own identity and the audit marker
   `acting_as_platform_admin`; tenant-scoped actions still require membership.
4. **Invitation email.** Delivery remains a dev outbox/mailer stub until the
   Phase 5 email integration; pending rows are inspectable and retryable.
5. **Phase 0 deployment blockers remain.** Profile-0 OCPP and CitrineOS
   `localDev` HTTP auth are still local-only (ADR-0008); the image EOL watch
   items remain pinned (ADR-0009).
6. **No hard delete/purge.** Offboarding is soft-delete; audit history is
   retained and there is no tenant/user purge endpoint in Phase 1.

## Phase 2 — station registry and CitrineOS integration

### ADR-0020: Phase 2 supports OCPP 1.6 only

- **Context.** Phase 2 must ingest real connector/session events while CitrineOS
  v2.1.0 supports OCPP 1.6, 2.0.1 and 2.1. The simulator and existing smoke
  workflow exercise OCPP 1.6.
- **Decision.** Station registration accepts only `ocpp_version='ocpp1.6'`.
  The database check, API schema and adapter reject other versions with
  `UNSUPPORTED_OCPP_VERSION`. Event ingestion rejects/flags other protocols in
  a later PR.
- **Consequences.** OCPP 2.x/2.1 stations remain future work. The adapter
  interface can grow a protocol-specific implementation without changing the
  registry.

### ADR-0021: Station identity, org/site codes and runtime split

- **Context.** `station_ref` is globally unique and immutable, and the ORG/SITE
  segments must remain tied to tenant/site records. Runtime heartbeat state
  changes frequently and must not churn registration data.
- **Decision.** `tenants.org_code` is unique and immutable; `sites.site_code` is
  unique per tenant and immutable. `station_ref` is
  `<ORG>-<SITE>-<NNN>` (max 20); the ORG segment must equal `tenants.org_code`
  and the SITE segment must equal `sites.site_code`. A database trigger enforces
  format/binding and immutability of `station_ref`, `tenant_id`, `site_id`,
  `org_code`, and `site_code`. Registration/config lives in `app.stations`;
  connection state/heartbeats live in `app.station_runtime_state`, created by a
  trigger in the same transaction as the station.
- **Consequences.** Relocating a station or renaming codes requires a future
  audited operation, not an ordinary PATCH. Site managers cannot mutate the
  identity fields. Phase 2a station creation rejects missing codes; the Phase 1
  tenant/site creation APIs still need an explicit `org_code`/`site_code` field
  in follow-up API hardening. The dev seed sets both.

### ADR-0022: Credential rotation uses a two-step WriteOnly workaround

- **Context.** CitrineOS v2.1.0 stores `BasicAuthPassword` in
  `VariableAttributes.value` as a WriteOnly variable. Its
  `writeReportedAttribute` deliberately preserves an existing WriteOnly value
  (B08.FR.03), so a single WriteOnly `provisionStationVariables` call does not
  change an existing password.
- **Decision.** Credential rotation calls CitrineOS
  `PUT /commands/provisionStationVariables` twice with the same new value:
  first `mutability=ReadWrite`, then `mutability=WriteOnly`. The API retries
  step 2 a few times; if it still fails, it records
  `credentials_state=rotation_incomplete`, alerts, returns no success, and the
  operator starts again with a fresh password. Rotation is tenant-admin (or
  platform-admin acting) only, audited, rate-limited, and `no-store`; passwords
  are never logged or written to audit details.
- **Known issue.** Rotation does not terminate a live OCPP connection; the
  charger keeps the old password until it reconnects/updates. Disconnect-on-rotate
  is deliberately not implemented in Phase 2.
- **Dependencies/files relied on.** CitrineOS v2.1.0
  `dist/src/apis/commands/provision-station-variables-endpoint.js`,
  `dist/src/apis/commands/set-station-password-endpoint.js`, and
  `dist/src/repositories/drizzle/variable-attribute.js` at pin
  `4fd7599b91c2fb6e6065e7c9b94be69880cced27`.
- **Password policy.** Default 32 alphanumeric characters. Symbols from the
  CitrineOS/OCPP set require a per-vendor override after hardware testing because
  URL/credential UIs break on `@ : | + =`.

### ADR-0023: Bounded Hasura provisioning exception for CitrineOS entities

- **Context.** CitrineOS v2.1.0 has no REST data API for creating Locations,
  ChargingStations, EVSEs or Connectors. Its Swagger at `/docs/json` exposes
  commands, `/dev`, `/ocpprouter`, `/permissions` and OCPP command surfaces
  only; the Operator UI performs entity CRUD through Hasura GraphQL.
- **Decision (approved exception).** The adapter may provision only
  `Locations`, `ChargingStations`, `Evses` and `Connectors` through a Hasura
  JWT role (`csms-provisioner`/`evstation_adapter`), never the Hasura admin
  secret. The committed overlay
  `infra/compose/hasura/evstation-adapter-metadata.json` grants column-level
  insert/update, pins `tenantId` to the service tenant, forces
  `capabilities.evstation_managed=true` on station insert, excludes
  `capabilities` from updates, requires the station marker through
  `ChargingStation` relationships for Evse/Connector writes, and grants no
  delete or `VariableAttributes` access. `csms-reader` has a separate read-only
  Hasura role. Existing unowned stations are never adopted: the adapter
  conflicts on an existing `ocppConnectionName` without the managed marker and
  relies on the CitrineOS `(ocppConnectionName, tenantId)` unique constraint.
- **Consequences / sunset.** This exception is bounded to Phase 2 provisioning.
  The sunset plan is to replace it with a supported CitrineOS REST data API
  (upstream contribution or later release); the Hasura write path and role are
  then removed. The adapter never writes CitrineOS databases directly.
- **Files relied on.** CitrineOS `/docs/json` (v2.1.0), Operator UI
  `src/lib/providers/data-provider/index.ts`, Hasura metadata
  `public_Locations.yaml`, `public_ChargingStations.yaml`, `public_Evses.yaml`,
  `public_Connectors.yaml`, and the Hasura metadata for the single default
  tenant.

### ADR-0024: Phase 2 ingestion roles land in PR 2b

- **Context.** PR 2a delivers the schema, RLS, registration, rotation, adapter
  clients and Hasura/Keycloak plumbing. Ingestion requires AMQP consumption,
  SECURITY DEFINER write functions, retry/DLQ behavior and simulator proof.
- **Decision.** PR 2a creates the event tables, partitions, parent-only grants
  and FORCE RLS. The `evstation_ingest` login role, `evstation_ingest_definer`
  functions, AMQP user/bindings, worker, offline sweeper and session
  reconciliation land in PR 2b. No ingest role or provider credential is
  granted to the API or browser in 2a.
- **Consequences.** Until 2b, event tables remain read-only/empty at the API
  layer and no CitrineOS event consumer exists. PR 2b is the pause point for
  ingestion + simulator E2E.

### ADR-0025: Phase 2 event retention and monthly partitioning

- **Context.** Session meter values, station status history and the ingestion
  ledger grow continuously. Finance/legal require at least 12 months of meter
  data; operational rejection data is shorter-lived.
- **Decision.** `session_meter_values`, `station_status_events` and
  `ingestion_events` are monthly range partitions keyed by the CitrineOS
  envelope timestamp (`csms_timestamp`), with a default partition as a safety
  net. Retention defaults: meter values at least 12 months (finance/legal will
  confirm the final number), status events 90 days, ingestion ledger 30 days.
  `idTag` is personal data under DPDP: it is never logged, is masked in API
  projections by default, and is pseudonymized or nulled after the session
  retention window.
- **Maintenance.** `app.ensure_event_partition(parent, month)` is a
  migration/superuser-invoked helper: it detaches the default partition, creates
  the monthly partition, moves matching default rows with
  `OVERRIDING SYSTEM VALUE`, reattaches the default, and applies
  `ENABLE/FORCE RLS` plus `REVOKE` to the new child. As of 2b it is
  SECURITY DEFINER owned by `evstation_event_owner` and granted only to
  `evstation_jobs`; the app and ingest login roles cannot run it.
- **Consequences.** Dropping old data is a partition operation, not row-by-row
  DELETE. Direct child access is denied; queries go through the parent RLS
  policies. A replay with the same event ref but a different envelope timestamp
  is intentionally not deduplicated; this limitation is documented in the
  ingestion ADR for PR 2b. Database/session timezone is pinned to UTC, and the
  partition function uses explicit `AT TIME ZONE 'UTC'` boundaries. A dedicated
  NOLOGIN/BYPASSRLS maintenance role limited to `ensure_event_partition` lands in
  PR 2b; 2a invokes the function as the migration/superuser only.

## Known issues (Phase 2a)

1. Phase 1 tenant/site creation APIs do not yet require `org_code`/`site_code`;
   Phase 2a station creation rejects missing codes. Follow-up API hardening
   will make them required.
2. Hasura v2.40.3 does not reliably enforce a JSONB `_contains` condition in an
   insert `check`; the adapter overlay therefore uses a server-side
   `set.capabilities = {evstation_managed: true}` preset plus an update/check
   marker and a non-updatable `capabilities` column. The adapter never adopts a
   station without the marker.
3. Live Hasura permissions and Keycloak service-account tests run in the smoke
   workflow, not in the required PR CI (they need the live stack).
4. Session/meter ingestion and the AMQP worker land in 2b. Live session
   streaming (SSE) remains PR 2c scope; no ingest credential is granted to the
   browser or API runtime.

### ADR-0026: Phase 2b ingestion uses a dedicated AMQP worker and SECURITY DEFINER functions

- **Context.** CitrineOS publishes every OCPP frame and connection transition
  on its `messages` topic exchange. The app role must never receive broad
  `frame.#` access, and the worker must not be able to publish or mutate
  arbitrary tenant rows.
- **Decision.** `evstation_ingest` is a LOGIN/NOBYPASSRLS role with EXECUTE
  only on narrowly named ingestion functions. A NOLOGIN/BYPASSRLS
  `evstation_ingest_definer` owns those functions and derives tenant/site from
  `station_ref`; callers cannot pass tenant/site. Event tables are owned by
  `evstation_event_owner` (also BYPASSRLS) so partition maintenance can run
  without broad table grants. `evstation_jobs` is a LOGIN/NOBYPASSRLS
  execute-only role for sweeper/retention functions. The worker consumes only
  `frame.inbound.{BootNotification,StatusNotification,Heartbeat,StartTransaction,MeterValues,StopTransaction}`,
  `frame.outbound.StartTransaction`, `connection.connected` and
  `connection.closed` from `evstation.ingest`.
- **Retry.** The main queue dead-letters to `evstation.ingest.dlx`, which routes
  to `evstation.ingest.retry` with a fixed 30 s TTL and back to `messages`.
  The worker nacks with `requeue=false`; it never publishes. After five
  retries (`x-death` count) it writes a `parked` ledger row and acks. Malformed
  frames are recorded as collapsed rejections and acked immediately.
- **Idempotency.** `csms_event_ref` is
  `frame:<direction>:<action>:<correlationId>:<sampleIndex>` and connection refs
  include station/state/envelope timestamp. Unique keys include the envelope
  timestamp. Meter rows additionally dedupe by `(session_id,
charger_reported_at)` because sample replay can arrive with a new envelope.
  A new accepted start response supersedes an existing live session on that
  connector (`stop_reason='superseded'`); stop is idempotent per transaction.
- **Ledger/volume.** Accepted heartbeats, status events and meter samples are
  not ledgered. The ledger contains rejected/parked events plus low-volume
  boot/connection/start/stop lifecycle. Unknown-station floods collapse by
  `(station_ref, reason_code, day)` with `occurrence_count`.
- **Known limitation.** The same event ref with a different envelope timestamp
  is not deduplicated. This is intentional for the first ingestion slice;
  a body-hash fallback would require a separately indexed dedup store.

### ADR-0027: Ingestion sharding plan for sustained rates above ~175 msg/s

- **Context.** The round-2 benchmark (`docs/evidence/phase2b-throughput.log`)
  published 12,000 mixed heartbeat/status/meter/start/stop messages over 60 s
  (200 msg/s target) through the real worker and PostgreSQL. With
  `prefetch(1)` and strictly sequential writes, p50 was 2.48 ms, p95 4.68 ms,
  CPU was 17.6%, the post-publish drain took 9.19 s, and sustained throughput
  was ~173 msg/s with a maximum sampled queue depth of 90. That is acceptable
  for the pilot volume but below the 200 msg/s target.
- **Decision.** Keep one ordered queue and `prefetch(1)` for correctness at the
  pilot rate, but plan sharding before the 500-station/200 msg/s target:
  1. Partition the ingest exchange by a stable station shard (`consistent_hash`
     on `ocppConnectionName` if the RabbitMQ plugin is available; otherwise
     application-side shard routing).
  2. Run one worker consumer group per shard, each with its own ordered queue
     and the same SECURITY DEFINER functions. Sessions never span shards, so
     ordering is preserved per station.
  3. Keep the single-writer-per-session invariant inside each shard; meter
     and stop events stay ordered by station.
  4. Add a shard-aware consumer-lag dashboard and per-shard queue-depth alerts.
  5. Re-run this benchmark with 200 msg/s across at least four shards before
     raising the target.
- **Consequences.** No migration is needed for the pilot; the existing
  `evstation.ingest` queue remains the single-shard implementation. The
  sharding work is deferred until the load target requires it and is tracked
  as a known limitation.

## Known issues (Phase 2b round 2)

1. Heartbeat-derived offline timeout is not implemented. The sweeper uses the
   configured timeout only; RUNBOOK requires a charger's boot heartbeat
   interval to be **<= timeout / 3** until interval tracking lands.
2. There is no dedicated broker shutdown test. The serial-chain shutdown is
   covered by unit ordering tests and the E2E drain/replay proof.
3. There is no non-UTC jobs-path test. Job month boundaries are computed in
   UTC, but a process-level TZ test is still missing.
4. `0033` intentionally removed table-level `connectors` UPDATE from
   `evstation_app`; station/event writes are worker-only. A future connector
   PATCH route will need column-level UPDATE grants added deliberately.
5. `session_meter_values.energy_wh` is the cumulative charger register;
   `sessions.energy_wh` is relative to `meter_start_wh`. API consumers must not
   compare the two directly.
6. `GET /sessions/:id` returns at most 200 meter samples by design.
7. `evstation_worker_events_parked_total` currently increments only for
   handler-thrown `POISON` parking. `RETRY_EXHAUSTED` parking is in the ledger
   but is counted as an ack, so the metric under-reports that path.

### ADR-0028: Platform admins cannot open tenant SSE streams in 2c

- **Context.** Platform admin acting-as is deferred (ADR-0018). An SSE stream
  outlives a single request, so silently choosing a tenant would turn a
  deferred impersonation feature into a new authorization path.
- **Decision.** `GET /events` returns `403 PLATFORM_ADMIN_NOT_SUPPORTED` for
  platform admins in 2c. Tenant admins/site managers/viewers use their selected
  tenant membership only. Acting-as remains deferred to a future audited
  feature.
- **Consequences.** Platform admins use tenant-scoped read pages or a future
  acting-as token exchange; they cannot receive cross-tenant streams.

### ADR-0029: SSE browser auth uses the dashboard BFF

- **Context.** `EventSource` cannot set an Authorization header, and query
  strings leak tokens into logs/history.
- **Decision.** The browser opens same-origin `GET /api/events`; the dashboard
  BFF reads the HttpOnly session cookie, refreshes the access token
  server-side, and streams from API `/events` with a server-only Bearer token.
  The BFF validates same-origin fetch metadata, sets `retry:` with jitter, and
  aborts the upstream request when the browser disconnects. No token/session id
  is accepted in a query string.
- **Consequences.** SSE shares the Phase 1 session trust boundary. The BFF
  route must disable buffering/compression and must be reachable only through
  the trusted proxy.

### ADR-0030: NOTIFY carries IDs; API does one RLS re-read per event

- **Context.** Postgres NOTIFY is limited to 8000 bytes and must not carry
  PII/idTag or become a second authorization path.
- **Decision.** Channel `evstation_events` carries only version, event id,
  kind, tenant/site/station/session ids, and occurred_at. The API holds the
  connection scope in memory, performs one `evstation_app` re-read with
  `app.actor_id` from a connection whose scope covers the payload and
  `app.tenant_id` from the payload, then fans out by the **re-read row's**
  tenant/site. RLS is the tenant gate; memory is the site gate. Invisible rows
  are dropped.
- **Consequences.** No event payload can spoof data; a rolled-back transaction
  never notifies. Missed events are not replayed; `resync` tells clients to
  refetch.

### ADR-0031: SSE events are snapshots with FIFO ordering and bounded buffers

- **Context.** Multiple updates can arrive out of order or faster than a client
  can consume; the API must not hold a DB transaction or unbounded memory for
  a stream.
- **Decision.** Every event data object includes `updated_at`; clients apply
  last-write-wins per entity and preserve FIFO per `session_id`/`station_id`.
  The API bounds per-connection buffering (256 KiB), limits streams to 10/user,
  250/tenant, 2,000/process, disconnects slow clients with `backpressure`, and
  sends keepalive comments every 15 s. It never takes a pooled DB connection
  for the lifetime of a stream; the only long-lived client is LISTEN.
- **Consequences.** Backpressure is explicit rather than silently growing
  memory. Metrics expose connections, drops, resyncs, backpressure closes,
  re-read p50/p95, and notification queue usage.

### ADR-0032: Ingest queue capacity uses a byte cap and monitoring-only user

- **Context.** A depth cap with `drop-head` could silently discard billing
  events; a retry dead-letter back through `messages` would reach CitrineOS's
  consumers. The worker user cannot query the management API for lag.
- **Decision.** The main queue uses a 5 GiB byte cap and `reject-publish` (not
  `drop-head`); retry dead-letters to the default exchange with routing key
  `evstation.ingest`. A separate `evstation_monitor` management user reports
  depth; unavailable depth is `NaN` with `queue_depth_available=0`, never 0.
  The queue definition is committed in
  `infra/compose/rabbitmq/evstation-ingest-definitions.json`. Reject-publish
  without publisher confirms can still lose a message, so the depth alert is
  the real control.
- **Consequences.** Operators must delete/redeclare queues when queue arguments
  change; RUNBOOK documents the procedure.

### ADR-0033: SSE scope refresh, token expiry, and LISTEN reconnect

- **Context.** Scope changes and token expiry must close streams promptly;
  LISTEN connections can be half-open or drop.
- **Decision.** Scope is refreshed every 30 s; token expiry also closes via a
  timer at JWT `exp`. Terminal reasons (`membership_removed`,
  `tenant_suspended`, `site_scope_lost`) make the browser call `es.close()`;
  `token_expired`/`server_shutdown` reconnect with jitter. A role change that
  narrows scope does not close the stream: the refreshed scope is applied and
  the stream narrows to the sites it can still see. Each API instance has one
  dedicated LISTEN client, pings it every 15 s, reconnects with exponential
  backoff, and sends `resync` only after the new LISTEN is confirmed. No
  replay/event log.
- **Consequences.** Revocation latency is bounded by 30 s plus jitter. Multi-
  instance fan-out is local; each instance sees every NOTIFY.

### ADR-0034: SSE kill switch, capped scope-refresh failures, and meter-notify interval

- **Context.** The 2c SSE path was new and unproven at scale, and a live
  stream is the hardest thing to take back once it is running. A failing
  scope refresh must also not leave a stream open indefinitely, and meter
  events arrive far more often than status or session events.
- **Decision.** Three knobs, all environment variables with safe defaults:
  - `SSE_ENABLED=false` makes `GET /events` return `503 SSE_DISABLED`. The
    dashboard hook reads `NEXT_PUBLIC_SSE_ENABLED=false` and stays idle
    instead of reconnecting in a loop. This is the operator's kill switch.
  - The scope refresh fails closed on access-denied errors (the stream is
    closed with `membership_removed`) and caps consecutive transient or
    unclassified failures at `SSE_MAX_REFRESH_FAILURES` (default 3), after
    which the stream closes with `scope_refresh_failed`. A successful refresh
    resets the counter.
  - The meter notify interval is `METER_NOTIFY_INTERVAL_S` (default 5). The
    worker passes it to Postgres as `evstation.meter_notify_interval_s`, and
    the ingest function only emits `session.meter` when the session's energy
    changed and the interval has elapsed. An identical timestamp never
    re-notifies.
- **Consequences.** The kill switch lets an operator stop the realtime path
  without a deploy. The refresh cap bounds how long a stream can stay open
  against a database it can no longer read. The meter interval caps the
  per-session notification rate; it does not affect how much meter data is
  stored, only how much of it is streamed.
