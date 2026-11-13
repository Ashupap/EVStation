# Phase 2 acceptance matrix

Status: implementation through Phase 2c review candidate; Phase 2a tag
`phase-2a-complete`, Phase 2b tag `phase-2b-complete` (merge `39a8828`).
Phase 2c is on `phase2c/sse` and is not merged/tagged until review.

| #   | Criterion                                                                                                                    | Command / evidence                                                                                                                 | Status         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Station can be registered through `POST /stations` with admin JWT, then connected on `:8082` with returned Basic credentials | `pnpm test:e2e:phase2b`; `docs/evidence/phase2b-e2e.log`                                                                           | PASS           |
| 2   | Credential rotation is tenant-admin only, lock-serialized and audited                                                        | `pnpm vitest run apps/api/test/api.test.ts`; rotation tests                                                                        | PASS           |
| 3   | Boot, status, heartbeat, session lifecycle, meter values, supersede, stale close                                             | `pnpm test:db`; `docs/evidence/phase2b-e2e.log`                                                                                    | PASS           |
| 4   | Retry/DLX/TTL, poison parking and no delivery to CitrineOS consumers                                                         | `AMQP_LIVE_TEST=1 pnpm vitest run packages/csms-adapter/test/amqp-retry.live.test.ts`; `docs/evidence/phase2b-amqp-retry-live.log` | PASS           |
| 5   | Retention, monthly partitions and default-partition movement                                                                 | `pnpm test:db`; `docs/evidence/phase2b-meter-dedup-explain.log`; `docs/evidence/phase2b-write-timings.log`                         | PASS           |
| 6   | RLS isolation and route-registry fail-closed behavior                                                                        | `pnpm test:db`; `pnpm vitest run apps/api/test`                                                                                    | PASS           |
| 7   | SSE cross-tenant spoof is dropped; real tenant event is delivered; platform admin gets `403 PLATFORM_ADMIN_NOT_SUPPORTED`    | `pnpm vitest run apps/api/test/sse.test.ts`; `pnpm vitest run apps/api/test/api.test.ts`                                           | PASS           |
| 8   | NOTIFY is emitted only after commit; heartbeat emits nothing; meter notification is throttled                                | `pnpm vitest run packages/db/test/phase2c.test.ts`; `docs/evidence/phase2c-s1-notify-rollback.log`                                 | PASS           |
| 9   | SSE scope revocation, backpressure/slow-client, and N-stream load check                                                      | Not yet automated; design and metrics are in place                                                                                 | PARTIAL / open |
| 10  | Dashboard BFF streams with server-side token and client abort aborts upstream                                                | Code path in `apps/dashboard/src/app/api/events/route.ts`; no dedicated automated test                                             | PARTIAL / open |
| 11  | Live simulator → worker → NOTIFY → `/events` client with latency                                                             | Not yet automated                                                                                                                  | PARTIAL / open |
| 12  | Simulator end-to-end through ingestion and tenant API reads                                                                  | `pnpm test:e2e:phase2b`; CI smoke run                                                                                              | PASS           |
| 13  | Phase 2 documentation, RUNBOOK, ADRs, known issues                                                                           | `docs/KNOWN_ISSUES.md`, `docs/RUNBOOK.md`, ADR-0028–0033                                                                           | PASS           |

## Commands

```shell
pnpm install --frozen-lockfile
pnpm lint .
pnpm format:check .
pnpm typecheck
pnpm test
pnpm test:db
pnpm test:e2e:phase2b
AMQP_LIVE_TEST=1 pnpm vitest run packages/csms-adapter/test/amqp-retry.live.test.ts
```

Manual check completed for this acceptance record: the dashboard `returnTo`
open-redirect check (`/auth/login?returnTo=//evil.example`) stays on the
dashboard origin. Automated `safeReturnTo`/Playwright tests remain primary.
