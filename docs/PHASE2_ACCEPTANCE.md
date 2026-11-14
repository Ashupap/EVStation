# Phase 2 acceptance matrix

Status: Phase 2a, 2b and 2c are merged and tagged (`phase-2a-complete`
76cdfc0, `phase-2b-complete` 39a8828, `phase-2c-complete` 192d523). The
`phase2c-evidence` follow-up added the live latency and N-stream load
evidence; it is not merged or tagged yet.

| #   | Criterion                                                                                                                             | Command / evidence                                                                                                                 | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Station can be registered through `POST /stations` with admin JWT, then connected on `:8082` with returned Basic credentials          | `pnpm test:e2e:phase2b`; `docs/evidence/phase2b-e2e.log`                                                                           | PASS   |
| 2   | Credential rotation is tenant-admin only, lock-serialized and audited                                                                 | `pnpm vitest run apps/api/test/api.test.ts`; rotation tests                                                                        | PASS   |
| 3   | Boot, status, heartbeat, session lifecycle, meter values, supersede, stale close                                                      | `pnpm test:db`; `docs/evidence/phase2b-e2e.log`                                                                                    | PASS   |
| 4   | Retry/DLX/TTL, poison parking and no delivery to CitrineOS consumers                                                                  | `AMQP_LIVE_TEST=1 pnpm vitest run packages/csms-adapter/test/amqp-retry.live.test.ts`; `docs/evidence/phase2b-amqp-retry-live.log` | PASS   |
| 5   | Retention, monthly partitions and default-partition movement                                                                          | `pnpm test:db`; `docs/evidence/phase2b-meter-dedup-explain.log`; `docs/evidence/phase2b-write-timings.log`                         | PASS   |
| 6   | RLS isolation and route-registry fail-closed behavior                                                                                 | `pnpm test:db`; `pnpm vitest run apps/api/test`                                                                                    | PASS   |
| 7   | SSE cross-tenant spoof is dropped; real tenant event is delivered; platform admin gets `403 PLATFORM_ADMIN_NOT_SUPPORTED`             | `pnpm vitest run apps/api/test/sse.test.ts`; `pnpm vitest run apps/api/test/api.test.ts`                                           | PASS   |
| 8   | NOTIFY is emitted only after commit; heartbeat emits nothing; meter notification is throttled                                         | `pnpm vitest run packages/db/test/phase2c.test.ts`; `docs/evidence/phase2c-s1-notify-rollback.log`                                 | PASS   |
| 9a  | SSE revocation: membership_removed, tenant_suspended, site_scope_lost, token_expired, role narrowing, plus unaffected parallel stream | `apps/api/test/sse-revocation.test.ts`                                                                                             | PASS   |
| 9b  | SSE slow-consumer backpressure: deterministic hub test + best-effort raw-net integration                                              | `apps/api/test/sse-backpressure.test.ts`, `sse-revocation.test.ts`                                                                 | PASS   |
| 9c  | N-stream load run: 200 concurrent streams, 1500 events published, 300000 frames delivered, no event dropped, no stream closed         | `pnpm test:e2e:phase2c-load`; `docs/evidence/phase2c-load-200.log`                                                                 | PASS   |
| 10  | Dashboard BFF streams with server-side token and client abort aborts upstream                                                         | `apps/dashboard/test/events-route.test.ts`                                                                                         | PASS   |
| 11  | Live simulator → worker → NOTIFY → `/events` client with latency (p50 37 ms, p95 56 ms over 5 status events)                          | `pnpm test:e2e:phase2c-latency`; `docs/evidence/phase2c-live-latency.log`                                                          | PASS   |
| 12  | Simulator end-to-end through ingestion and tenant API reads                                                                           | `pnpm test:e2e:phase2b`; CI smoke run                                                                                              | PASS   |
| 13  | Phase 2 documentation, RUNBOOK, ADRs, known issues                                                                                    | `docs/KNOWN_ISSUES.md`, `docs/RUNBOOK.md`, ADR-0028–0034                                                                           | PASS   |

## Commands

```shell
pnpm install --frozen-lockfile
pnpm lint .
pnpm format:check .
pnpm typecheck
pnpm test
pnpm test:db
pnpm test:e2e:phase2b
pnpm test:e2e:phase2c-latency
pnpm test:e2e:phase2c-load
AMQP_LIVE_TEST=1 pnpm vitest run packages/csms-adapter/test/amqp-retry.live.test.ts
```

The Phase 2c evidence scripts need the local stack running (`pnpm dev:stack`,
`pnpm db:migrate && pnpm db:seed`) and the simulator's Python dependencies
installed. They start their own API and worker on their own ports, so they
do not collide with the Phase 2b end-to-end test.

The committed evidence logs were produced on a 4-core Intel i3-4005U. The
nightly smoke workflow runs both scripts and uploads its own logs as the
`phase2c-evidence` artifact; on a faster runner the same run reports lower
latency (p50 10 ms, p95 15 ms) and a higher per-station re-read ceiling
(300 events/s). Both runs delivered every event to every stream with no
drops.

Browser-level check: the automated Chromium case
`never redirects a malicious returnTo off the dashboard origin`
(`apps/dashboard/test/e2e/dashboard.spec.ts`) passes against the built
dashboard; a separate human-driven browser session was not recorded.
Automated `safeReturnTo`/Playwright coverage remains primary.
