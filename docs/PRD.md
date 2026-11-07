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
