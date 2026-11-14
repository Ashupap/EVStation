## 2. Product overview

We are building a Central Management System (CMS) for an EV charging network in India. The CMS sits on top of **CitrineOS** (open-source OCPP CSMS, TypeScript), which handles the OCPP WebSocket connections to chargers. We build everything around it: an API layer, authentication, multi-tenancy, and an operator dashboard. Later phases add a driver mobile app, trip advisor, OCPI roaming, payments, telematics and surveillance.

**Primary users (Phase 1 to 5)**

- **Platform admin:** runs the whole platform; creates tenants.
- **Tenant admin:** manages one organization (a charge point operator or partner).
- **Site manager:** manages specific sites and their stations.
- **Viewer / support:** read-only access, can view sessions and alerts.

**Business goals**

- One system managing chargers from multiple hardware vendors and multiple tenant organizations.
- Operators can see live station status, run remote commands safely, and review sessions and energy.
- Strict tenant data isolation. A tenant must never see another tenant's data.

**Success metrics for the MVP**

- A simulated charger can boot, charge, and stop, and the session appears in the dashboard within 5 seconds of each event.
- Zero cross-tenant data leaks in the automated isolation test suite.
- Remote commands succeed or fail with a clear status, and every command is audited.

## 3. Scope

**In scope (Phases 0-5):** repository and infrastructure setup, authentication, multi-tenancy, station registry, CitrineOS integration, operator dashboard, remote operations, sessions and energy reporting, basic tariffs and RFID authorization, alerts, CSV reports, hardening.

**Out of scope for now (design so they can be added later):**

- Driver mobile app, trip advisor, map-platform integration (Google Maps etc.)
- OCPI roaming and third-party network onboarding
- Online payments, invoicing, GST invoices
- Telematics pipeline and surveillance/video integration
- Smart charging and load management beyond passing through basic commands

When designing tables, IDs and APIs, leave room for the out-of-scope items (for example, `station_id` and `session_id` must be stable and reusable across future modules).

## 4. Architecture and tech stack

```
Browsers (operator dashboard)
        |
   Our API layer  --- Postgres (our DB, row-level security)
        |
   CSMS adapter (single module)
        |
   CitrineOS (REST API, message API, OCPP WebSocket servers)
        |
   Chargers (OCPP 1.6J now, 2.0.1 later)
```

| Concern | Choice |
| --- | --- |
| Language | TypeScript everywhere (Node 24 LTS, exact-pinned; see docs/DECISIONS.md) |
| Monorepo | pnpm workspaces |
| API service | Fastify with Zod schemas, OpenAPI spec generated from code |
| Our database | PostgreSQL 15+ (separate database from CitrineOS) |
| ORM / migrations | Drizzle ORM or Prisma, with versioned SQL migrations |
| Auth | Keycloak (self-hosted, OIDC) behind a thin auth module. Do not hand-roll password handling or token signing |
| Dashboard | Next.js (App Router), Tailwind, shadcn/ui, TanStack Query |
| Maps | Leaflet with OpenStreetMap tiles (no paid map key needed in Phase 1) |
| Realtime to browser | Server-sent events (SSE) from our API |
| Tests | Vitest (unit/integration), Testcontainers (Postgres), Playwright (end-to-end) |
| Local dev | Docker Compose: Postgres, Keycloak, CitrineOS stack, charger simulator |
| CI | GitHub Actions: lint, typecheck, unit, integration, e2e on every PR |

**Proposed repository layout**

```
/apps/api              Fastify API service
/apps/dashboard        Next.js operator dashboard
/packages/db           Schema, migrations, RLS policies, seed data
/packages/csms-adapter Only module allowed to talk to CitrineOS
/packages/shared       Shared types, Zod schemas, constants
/tools/simulator       Charger simulator (charger_simulator.py, OCPP 1.6J)
/infra/compose         Docker Compose files and env templates
/docs                  ARCHITECTURE.md, DECISIONS.md (ADRs), API.md, RUNBOOK.md
```

## 5. Rules the agent must follow (the agent contract)

1. **Do not guess CitrineOS APIs.** Read the OpenAPI/Swagger of the running CitrineOS instance (default `http://localhost:8080/docs`) and the repo README for the pinned version. Generate a typed client from its OpenAPI spec where possible. Record the pinned CitrineOS version in `docs/DECISIONS.md`. CitrineOS API paths and ports differ between versions.
2. **Only `packages/csms-adapter` may call CitrineOS.** Nothing else imports a CitrineOS client or hits its URLs. The adapter exposes a stable interface to the rest of our code (see Phase 2).
3. **Tenant isolation is mandatory on every query.** Every tenant-scoped table has `tenant_id` and a Postgres row-level security (RLS) policy. The API sets the tenant context from the verified token, never from a request body or query parameter.
4. **No secrets in code or logs.** Use environment variables and `.env.example` files. Never log tokens, passwords, or full OCPP payloads that contain credentials.
5. **Every remote command is audited** (who, tenant, station, command, payload hash, result, timestamp).
6. **Validate all input** with Zod at the API boundary. Return consistent error shapes: `{ error: { code, message, details? } }`.
7. **Write tests with the code, not after.** A task is not done without tests. Never delete or weaken a test to make a build pass; explain the failure instead.
8. **Small, reviewable commits.** One feature per branch, descriptive messages, no unrelated refactors.
9. **Record decisions.** Any non-obvious choice goes in `docs/DECISIONS.md` as a short ADR (context, decision, consequences).
10. **Time and money.** Store timestamps in UTC (`timestamptz`), display in the tenant's time zone (default `Asia/Kolkata`). Store money as integer minor units (paise) with a currency code (default `INR`). Store energy as integer Wh.
11. **If something is ambiguous, stop and ask** instead of inventing requirements. List assumptions at the start of each phase.
12. **Do not add dependencies casually.** Prefer well-maintained, widely used libraries and pin versions.

## 6. Domain model

All tenant-scoped tables include `id` (UUID), `tenant_id`, `created_at`, `updated_at`.

| Table | Key fields |
| --- | --- |
| `tenants` | name, slug, time\_zone, currency, status (active/suspended) |
| `users` | external\_id (Keycloak subject), email, name, status |
| `memberships` | user\_id, tenant\_id, role (tenant\_admin / site\_manager / viewer), optional site scope |
| `platform_admins` | user\_id (platform-level role, outside any tenant) |
| `sites` | tenant\_id, name, address, latitude, longitude, time\_zone, notes |
| `stations` | tenant\_id, site\_id, station\_ref (the OCPP charge point ID, globally unique), vendor, model, serial, firmware\_version, ocpp\_version, status, last\_heartbeat\_at, last\_boot\_at |
| `connectors` | station\_id, connector\_number, type (CCS2, Type2, etc.), max\_power\_w, status |
| `tariffs` | tenant\_id, name, price\_per\_kwh\_paise, idle\_fee\_per\_min\_paise, session\_fee\_paise, active |
| `station_tariffs` | station\_id, tariff\_id, valid\_from |
| `auth_tags` | tenant\_id, id\_tag (RFID), label, status, expires\_at |
| `sessions` | tenant\_id, station\_id, connector\_id, csms\_transaction\_ref, id\_tag, started\_at, ended\_at, energy\_wh, status, stop\_reason, cost\_paise |
| `session_meter_values` | session\_id, recorded\_at, energy\_wh, power\_w |
| `command_audit` | tenant\_id, user\_id, station\_id, command, payload\_hash, result\_status, error, created\_at |
| `alerts` | tenant\_id, station\_id, type, severity, status (open/acknowledged/resolved), opened\_at, resolved\_at |
| `alert_rules` | tenant\_id, type, threshold, enabled |

Notes: `station_ref` must be unique across the platform (it is the identity the charger connects with). The mapping from `station_ref` to `tenant_id` is the foundation of isolation. Events arriving from CitrineOS are resolved to a tenant through this mapping.

## 7. Roles and permissions

| Capability | Platform admin | Tenant admin | Site manager | Viewer |
| --- | --- | --- | --- | --- |
| Create/suspend tenants | Yes | No | No | No |
| Invite and manage users in own tenant | Yes | Yes | No | No |
| Create/edit sites | Yes | Yes | Edit own sites only (no create/delete) | No |
| Register/edit stations | Yes | Yes | Own sites | No |
| View stations, sessions, alerts | Yes | Yes | Own sites | Own tenant (read-only) |
| Send remote commands | Yes | Yes | Own sites | No |
| Manage tariffs and RFID tags | Yes | Yes | No | No |
| Export reports | Yes | Yes | Own sites | No |
| View audit log | Yes | Yes | No | No |

A platform admin acting inside a tenant must be recorded in the audit log with a clear "acting as" marker.

## Phase 1: Authentication, tenants and row-level security

**Goal:** secure login and a tenant model where isolation is enforced by the database, with automated proof.

**Tasks**

1. Implement the schema for `tenants`, `users`, `memberships`, `platform_admins`, and `sites` with migrations.
2. Integrate Keycloak OIDC: the API verifies JWTs (signature, issuer, audience, expiry). Map the token subject to `users`.
3. Implement RLS policies on all tenant-scoped tables. The API sets a per-request database setting (for example `app.tenant_id`) inside a transaction. Use a database role for the app that cannot bypass RLS.
4. Implement a permission layer from the matrix in Section 7. Centralize it (one `authorize(user, action, resource)` module); do not scatter role checks.
5. Endpoints: `POST/GET/PATCH /tenants` (platform admin), `POST /tenants/:id/invitations`, `GET/PATCH /me`, `GET/POST/PATCH /sites`, `GET /users`, role changes.
6. Seed script: one platform admin, two tenants with a few users each, to support isolation tests.
7. Dashboard shell only: login via Keycloak, tenant switcher for users with multiple memberships, empty home page, role-aware navigation.

**Acceptance criteria**

- A user from tenant A cannot read, list, update, or delete any tenant B resource through any endpoint, by ID guessing or otherwise.
- A request with a forged `tenant_id` in the body/query is ignored or rejected.
- Direct database queries as the app role return zero cross-tenant rows (RLS proven independently of API code).
- Expired, wrong-audience, and tampered tokens are rejected with 401.
- Role matrix is enforced: each denied action returns 403 with a consistent error body.

**Tests (mandatory)**

- An **isolation test suite** that iterates over every tenant-scoped endpoint and verifies cross-tenant access fails. New endpoints must be added to this suite automatically (for example by iterating over the route registry) so future phases cannot forget it.
- RLS tests at the SQL level using the app role.
- Permission matrix tests: one test per role per capability.
- Playwright test: login, wrong-role navigation is blocked.

### Additional Phase 1 criteria (approved extras)

These were approved alongside the section above and are equally binding:

- Invitations are stored and have an accept flow; email delivery is a logged
  stub behind an interface until Phase 5 (no tokens in logs).
- Every security-relevant action is audited (tenant create/suspend, role
  changes, invitations, platform-admin "acting as").
- The dashboard session is server-side (opaque session cookie), tokens never
  reach browser JavaScript or storage, and state-changing BFF requests are
  CSRF-protected.
- A production-like compose overlay sets
  `allowUnknownChargingStations: false`; a test proves an unregistered
  station is refused while a commissioned station boots.
- OpenAPI is generated from code; errors always use
  `{ error: { code, message, details? } }`.


## Phase 2: Station registry and CitrineOS integration

**Goal:** register stations through our API, see their live state, and receive their session events, all via a single adapter.

**Tasks**

1. Build `packages/csms-adapter` with a stable interface. Suggested shape:
   - `registerStation(stationRef, config)`
   - `getStationStatus(stationRef)`
   - `listStations()`
   - `sendCommand(stationRef, command, params)` returning a result with status and raw response
   - `subscribeEvents(handler)` for boot, status, heartbeat, transaction start/stop, meter values Implement it against the pinned CitrineOS version after reading its OpenAPI spec. Include a **fake adapter** for tests.
2. Decide how events reach us (CitrineOS message broker, webhooks, GraphQL subscriptions, or polling) after reading the docs. Record the decision as an ADR. If polling is the only option, poll at a configurable interval (default 5 s) and cache.
3. Event ingestion service: resolve `station_ref` to `tenant_id` through the `stations` table. Reject and log events for unknown stations. Write status updates, `last_heartbeat_at`, sessions and meter values into our tables idempotently (duplicate events must not create duplicate sessions).
4. Endpoints: `POST/GET/PATCH /stations`, `GET /stations/:id`, `GET /stations/:id/connectors`, `GET /sessions`, `GET /sessions/:id`.
5. Station registration flow: creating a station in our DB also registers it in CitrineOS through the adapter; failure in either step rolls back or marks the station `registration_failed` with a retry.
6. A reconciliation job that compares our stations to CitrineOS and reports drift.
7. SSE endpoint `GET /events` streaming status changes for the caller's tenant only.

**Acceptance criteria**

- Registering a station via our API, then running the simulator with that ID, results in the station showing `online` with firmware and model within 5 seconds.
- A full simulated session creates exactly one `sessions` row with correct energy (Wh) and timestamps, and meter values are stored.
- Replaying the same events does not duplicate data.
- Events for an unknown `station_ref` are rejected and logged without crashing.
- SSE streams never include another tenant's events (covered by the isolation suite).

**Tests**

- Adapter contract tests run against both the fake adapter and a real CitrineOS in CI/e2e.
- Integration test: simulator session end to end through to our DB.
- Idempotency and out-of-order event tests.
- Isolation suite extended to all new endpoints and SSE.

**Agent starter prompt**

> Implement Phase 2. Read the CitrineOS Swagger of the pinned version first and write an ADR on how events will be consumed. Keep every CitrineOS call inside `packages/csms-adapter`. Show how you verified each acceptance criterion using the charger simulator.

---

## Phase 3: Operator dashboard (read-only views)

**Goal:** an operator can see their network at a glance.

**Tasks**

1. Pages: **Overview** (counts of stations online/offline/charging/faulted, energy today, sessions today), **Stations** (filterable table with status, site, vendor, last heartbeat), **Station detail** (connectors, current session, recent sessions, status history, firmware/model), **Map** (Leaflet markers colored by status, clustered), **Sessions** (filter by date, station, site, status; pagination), **Sites** (list and detail).
2. Live updates from SSE: status badges and counts update without page reload; show a "live" indicator and handle reconnects.
3. Tenant branding basics: tenant name and logo in the header.
4. Responsive layout for tablets; accessible components (keyboard navigation, contrast, labels).
5. Empty, loading, and error states for every page.
6. Time display in the tenant's time zone; INR formatting with the Indian number system.

**Acceptance criteria**

- With the simulator running, a status change appears in the dashboard within 5 seconds without refresh.
- A site manager only sees their sites; a viewer sees no action buttons.
- Lists with 10,000 sessions paginate server-side and remain responsive.
- No page makes direct calls to CitrineOS, only to our API.

**Tests**

- Component tests for status badges and tables.
- Playwright flows per role: login, navigate each page, verify visible data and hidden actions.
- Visual regression snapshots for key pages (optional).

**Agent starter prompt**

> Implement Phase 3 on top of the existing API. Do not add endpoints without updating the isolation suite. Provide screenshots of each page in empty, loaded and error states, and Playwright results for each role.

---

## Phase 4: Remote operations, tariffs, RFID and audit

**Goal:** operators can safely control stations and configure basic pricing and authorization.

**Tasks**

1. Commands via the adapter and API: remote start, remote stop, reset (soft/hard), unlock connector, change availability, get configuration, trigger message. Each command: `POST /stations/:id/commands` with a Zod-validated body per command type.
2. Command lifecycle: `pending`, `accepted`, `rejected`, `timed_out`, `failed`, stored in `command_audit`. Station offline means fail fast with a clear message. Use timeouts and do not auto-retry destructive commands.
3. Safety: confirmation dialog in the UI for reset and stop; remote stop requires an active session; rate-limit commands per user and per station.
4. Tariffs: CRUD, assign to stations with `valid_from`. Compute `cost_paise` on session completion from the tariff active at session start. Keep the calculation in one tested module.
5. RFID tags: CRUD, import via CSV, status (active/blocked), expiry. Provide authorization data to CitrineOS through the adapter so `Authorize` requests resolve correctly (agent must verify how the pinned CitrineOS version handles authorization lists).
6. Audit log page for tenant admins with filters and CSV export.
7. Firmware update **design only** (ADR and API sketch); implementation is a later phase.

**Acceptance criteria**

- From the dashboard, remote start with a valid tag on the simulator starts a session; remote stop ends it; reset makes the simulator reconnect and boot again.
- Every command, including rejected and timed-out ones, appears in the audit log with user and result.
- A viewer or a site manager outside the station's site cannot send commands (403, and audited as denied).
- Cost calculation matches hand-computed examples, including tariff changes mid-day and zero-energy sessions.
- A blocked or expired RFID tag is rejected by the simulator test.

**Tests**

- Unit tests for the tariff calculator with table-driven cases.
- Command lifecycle tests with the fake adapter (accept, reject, timeout, offline).
- End-to-end tests with the simulator for start, stop, reset.
- Isolation suite extended; rate-limit tests.

**Agent starter prompt**

> Implement Phase 4. Remote commands control physical equipment, so be conservative: validate, audit, rate-limit, and never retry destructive commands automatically. Show the command state machine as a diagram in `docs/ARCHITECTURE.md` and include tests for each transition.

---

## Phase 5: Alerts, reports and hardening

**Goal:** the MVP is observable, reportable, and ready for a pilot with real chargers.

**Tasks**

1. Alert rules and engine: station offline (no heartbeat for N minutes), connector faulted, repeated failed sessions, session stuck beyond a threshold, firmware mismatch. Alerts have open/acknowledged/resolved states, deduplication, and de-bounce to avoid flapping.
2. Notifications: in-app first; email via SMTP (configurable). Notification preferences per user.
3. Reports: uptime per station and site, energy and sessions by period, revenue by tariff, top/bottom stations. CSV export and date-range filters, with server-side aggregation.
4. Observability: structured JSON logs with request IDs, Prometheus metrics endpoint, health and readiness endpoints, Grafana dashboard JSON for API latency, event ingestion lag, and adapter errors.
5. Security hardening: dependency audit in CI, secure headers, CORS allow-list, rate limiting on auth-related endpoints, input size limits, secret scanning, backups and restore test for Postgres.
6. Performance: load test with 500 simulated stations sending heartbeats and meter values; document results and bottlenecks.
7. Pilot readiness: deployment guide (containers behind a reverse proxy with TLS), environment configuration, runbook for common incidents, and a **commissioning checklist** for real chargers per vendor model (boot, authorize, start, stop, remote stop, reset, power loss and reconnect, firmware update).

**Acceptance criteria**

- Taking a simulated station offline opens an alert within the configured time and closes it on reconnect, without duplicates.
- Reports match hand-calculated totals for a seeded dataset.
- The 500-station load test completes with documented p95 API latency and no lost sessions.
- A restore from backup is demonstrated and documented.
- CI includes dependency and secret scanning with no high-severity findings unaddressed.

**Tests**

- Alert engine tests including flapping and dedup.
- Report aggregation tests on seeded data.
- Load test script in `/tools/loadtest`.
- Final full-suite run: unit, integration, isolation, e2e, all green.

**Agent starter prompt**

> Implement Phase 5. Produce evidence for each acceptance criterion (logs, test output, load test numbers). Finish with an updated RUNBOOK and a list of known limitations and risks for the pilot.

---

## 8. Cross-cutting non-functional requirements

- **Security:** OWASP ASVS Level 2 as a target; least privilege for database roles; no shared credentials between environments.
- **Privacy:** minimize personal data; plan for India's DPDP Act 2023 (purpose limitation, deletion on request, access logging). Video and number-plate data arrive in later phases and need their own retention rules.
- **Reliability:** event ingestion must tolerate duplicates, delays and out-of-order messages. The system must recover cleanly after restarts of any component.
- **Performance targets (pilot):** API p95 under 300 ms for list endpoints at 10,000 sessions per tenant; dashboard status update latency under 5 s; support at least 500 connected stations.
- **Compatibility:** support OCPP 1.6J first, structure the adapter so OCPP 2.0.1 features can be added without changing the rest of the API.
- **Documentation:** OpenAPI spec published from code; ADRs for every significant decision; runbook kept current.

## 9. Later phases (not for the agent yet)

| Phase | Content |
| --- | --- |
| 6 | Driver mobile app (discovery, QR start, payment), public station API |
| 7 | Trip advisor, routing and map-platform integration |
| 8 | OCPI roaming, third-party network onboarding |
| 9 | Payments, invoicing, GST |
| 10 | Telematics pipeline (time-series store, health scoring) |
| 11 | Surveillance and video-event integration |
| 12 | Firmware management, smart charging and load management |

## 10. Assumptions and open questions

- Pilot chargers speak OCPP 1.6J. **To confirm with each vendor:** exact version, security profile support, firmware update method, meter-value reporting.
- Keycloak is acceptable for identity. If the business prefers a managed provider, only the auth module changes.
- The CitrineOS operator UI may be used internally for engineering diagnostics but is not the customer-facing dashboard.
- Which payment service provider will be used (Phase 9) and whether UPI is required at launch.
- Hosting target (cloud region in India, on-premise, or hybrid) and data-residency requirements.
- Whether tenants need white-label branding beyond name and logo.
