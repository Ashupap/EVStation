# Phase 1 acceptance matrix

Status snapshot: Phase 1 implementation through the review-2 close-out; see
the commit history for exact hashes. All commands below are run from a clean
checkout with Node 24.22.2 and pnpm 10.30.3. CI evidence is linked where the
local output is not the authoritative run.

| #   | PRD Phase 1 criterion / test                                                         | Commit(s)                       | Command / evidence                                              | Output / status                                                                              |
| --- | ------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Tenant A cannot read/list/update/delete tenant B resources through any endpoint.     | `98ad013`, `f3b02ad`            | `pnpm vitest run apps/api/test`                                 | 5 files, 62 tests passed (isolation + route-registry suites). **MET**                        |
| 2   | Forged `tenant_id` in body/query is ignored or rejected.                             | `98ad013`, `f3b02ad`            | `pnpm vitest run apps/api/test`                                 | Cross-tenant/forged-context API tests pass. **MET**                                          |
| 3   | Direct DB queries as the app role return zero cross-tenant rows (RLS proof).         | `487e073`, `f74d72f`, `8434bbd` | `pnpm test:db`                                                  | 3 files, 61 tests passed; `docs/evidence/phase1-rls-tests.log`. **MET**                      |
| 4   | Expired, wrong-audience and tampered JWTs return 401.                                | `98ad013`, `f3b02ad`            | `pnpm vitest run apps/api/test`                                 | JWT negative-path tests pass. **MET**                                                        |
| 5   | Role matrix enforced; denied actions return 403 with the consistent error body.      | `98ad013`, `f3b02ad`            | `pnpm vitest run apps/api/test`                                 | Permission matrix and error-shape assertions pass. **MET**                                   |
| 6   | Isolation suite iterates every tenant-scoped endpoint (including future ones).       | `98ad013`                       | `pnpm vitest run apps/api/test`                                 | Route-registry isolation suite passes. **MET**                                               |
| 7   | SQL-level RLS tests use the non-owner app role.                                      | `f74d72f`                       | `pnpm test:db`                                                  | PostgreSQL/Testcontainers RLS suite passes. **MET**                                          |
| 8   | One permission-matrix test per role per capability.                                  | `f3b02ad`                       | `pnpm vitest run apps/api/test`                                 | Role/capability matrix tests pass. **MET**                                                   |
| 9   | Playwright: login and wrong-role navigation is blocked.                              | `03e9785`, `9237d9a`            | `pnpm --filter @evstation/dashboard test:e2e`                   | 16 browser tests passed, including viewer route blocking. **MET**                            |
| 10  | Invitations stored with accept flow; email stub never logs tokens.                   | `487e073`, `22ef325`            | `pnpm test` + `pnpm --filter @evstation/dashboard test:e2e`     | Invitation/outbox tests and fragment-only accept E2E pass. **MET**                           |
| 11  | Security-relevant actions audited (tenant, role, invitation, platform-admin).        | `933039e`, `f3b02ad`            | `pnpm vitest run apps/api/test` + `pnpm test:db`                | Append-only audit and `acting_as_platform_admin` marker tests pass. **MET**                  |
| 12  | Dashboard session is server-side/opaque; CSRF-protected; tokens never in browser.    | `03e9785`, `9237d9a`, `1e54fc3` | `pnpm --filter @evstation/dashboard test:e2e` + `test:e2e:real` | 16 mocked + 3 real Keycloak tests passed; no token material in cookies/storage/body. **MET** |
| 13  | Production-like OCPP overlay: unknown station refused, commissioned station boots.   | `fdfc11d`                       | `pnpm test:ocpp:production-like`                                | Unregistered station refused; commissioned `cp001` booted Accepted. **MET**                  |
| 14  | OpenAPI generated from code; errors always `{ error: { code, message, details? } }`. | `98ad013`, `f3b02ad`            | `pnpm vitest run apps/api/test`                                 | OpenAPI generation and centralized error-shape tests pass. **MET**                           |

## Close-out commands

```shell
pnpm install --frozen-lockfile
pnpm lint .
pnpm format:check .
pnpm typecheck
pnpm test                       # 19 files, 184 tests
pnpm test:db                    # 3 files, 61 SQL/RLS tests
pnpm test:ocpp:production-like  # unknown station refused; cp001 boots Accepted
pnpm --filter @evstation/dashboard test:e2e        # 16 tests
pnpm --filter @evstation/dashboard test:e2e:real   # 3 tests (nightly/dispatch smoke)
pnpm --filter @evstation/dashboard build
```

Required PR CI (`.github/workflows/ci.yml`) runs lint, format, typecheck,
unit/integration tests and the mocked dashboard E2E. The real Keycloak + API
suite runs in `.github/workflows/smoke.yml` on nightly schedule and manual
dispatch; it is not a required PR check because it starts the full Docker stack.
