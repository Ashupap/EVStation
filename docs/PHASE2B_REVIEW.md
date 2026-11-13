# Phase 2b review map

Implementation commit: `1b7ffcd7336001fbc8846166d5b48d78dd479aaf`

Round 2 review-fix commit: `0753205ebd3c563b3ae55d4cf327296a6e36efdf`

Round 3 merge-gate commit: `010be9a15e0ec80fe3db384b1912e3a25e22f7e9`

Status: implementation + review fixes complete locally; not yet merged.

## Evidence

- Full test suite: `pnpm test` — 30 files passed, 2 skipped; 257 tests passed, 4 skipped.
- Per-workspace counts from `pnpm vitest run <dir>`:
  - `packages/db/test`: 6 files, 98 passed
  - `apps/api/test`: 6 files, 76 passed
  - `apps/worker/test`: 3 files, 10 passed
  - `packages/csms-adapter/test`: 5 passed + 2 skipped files; 13 passed + 4 skipped tests
  - `packages/shared/test`: 1 file, 1 passed
  - `apps/dashboard/test`: 9 files, 59 passed
- Phase 2b E2E: `docs/evidence/phase2b-e2e.log` — PASS with API registration,
  8082 Basic auth, tenant-scoped API/RLS assertions, AMQP replay/out-of-order
  and cross-tenant replay.
- Red-first: `docs/evidence/phase2b-red-first.log` — 8 DB tests failed when
  0031/0032 were removed; worker retry test failed when the retry branch was
  disabled.
- Earlier worker/app smoke: `docs/evidence/phase2b-ingestion-smoke.log`,
  `docs/evidence/phase2b-ingestion-worker.log`.

## Approved amendment checklist

| #   | Amendment                                                                  | Status                                                                                               | Commit / test                                                                                    |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Event-tree maintenance ownership + BYPASSRLS/job separation                | Done                                                                                                 | 0031, 0032; `phase2b.test.ts > roles and ownership`                                              |
| 2   | Broker-native retry/DLX/TTL, 5 deaths then parked                          | Done                                                                                                 | `provision-amqp.mjs`, worker `handleEvent`; `worker/test/ingest.test.ts > retries...`            |
| 3   | Start response supersedes old live session; stale close; conflict scope    | Partial: supersede/stale done; `SESSION_CONFLICT` remains duplicate handling                         | `phase2b.test.ts > start response supersedes...`, `close_stale_sessions`                         |
| 4   | Ledger only rejected/parked + lifecycle; unknown collapse; station_ref cap | Done                                                                                                 | 0031/0032; `phase2b.test.ts > unknown-station rejection...`; E2E `A-ledger`                      |
| 5   | Runtime/connector ordering by `csms_timestamp`; stale connected cannot win | Done                                                                                                 | 0032; `phase2b.test.ts > out-of-order connection events...`; E2E `out-of-order`                  |
| 6   | Meter sampleIndex/units/cap and dedup by charger timestamp                 | Done                                                                                                 | worker `meter.ts`; `phase2b.test.ts > meter redelivery`, worker meter tests                      |
| 7   | Charger time ±24h else CSMS; source flags and raw charger time             | Done                                                                                                 | 0031 pending columns; 0032 start/stop; `phase2b.test.ts > ...charger_started_at`                 |
| 8   | Boot reported_* only; unsupported/decommissioned handling                  | Done                                                                                                 | 0031/0032; `phase2b.test.ts > boot records reported fields`; E2E `A-boot`                        |
| 9   | Connector 0 = station-level status (`connector_id NULL`)                   | Done                                                                                                 | 0032; `phase2b.test.ts > boot/status ledger volume`                                              |
| 10  | last_seen throttled; offline timeout = max(config, 3×heartbeat)            | Partial: throttle done; heartbeat-derived interval is not tracked                                    | 0032/worker jobs; no test for heartbeat-derived timeout                                          |
| 11  | Expired pending starts removed immediately/idTag gone                      | Done                                                                                                 | 0032 `expire_pending_starts`; `phase2b.test.ts > jobs expire pending starts`                     |
| 12  | Failed session on rejected start response                                  | Done                                                                                                 | 0032; `phase2b.test.ts > rejected start responses create a failed session`                       |
| 13  | Suspended tenant ingestion continues                                       | Done                                                                                                 | 0032 deliberately has no tenant-status gate; `phase2b.test.ts > suspended tenants still ingest`  |
| 14  | idTag retention provisional 12 months + API masking                        | Partial: 365-day default configurable and API masks (`****` + last 4); DPDP period still provisional | worker `ID_TAG_RETENTION_DAYS`; API session tests                                                |
| B   | Option B maintenance model                                                 | Done                                                                                                 | 0031 ownership transfer + `ensure_event_partition` SECURITY DEFINER; parameterized 0032 job drop |

## Carry-over mapping

| Item                                                          | Status | Evidence                                                                                                                       |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| a. Consume only outbound `StartTransaction`                   | Done   | `provision-amqp.mjs` exact bindings; adapter `subscribeAmqpEvents`                                                             |
| b. Event key per envelope + sampleIndex; no ledger per sample | Done   | 0032 meter refs; E2E `A-ledger`/`A-meter`                                                                                      |
| c. `evstation_ingest` execute-only / definer ownership        | Done   | 0031/0032; roles/ownership test; red-first log                                                                                 |
| d. Exact AMQP bindings and least-privilege worker permissions | Done   | `provision-amqp.mjs` (`read ^evstation\\.ingest$`), E2E capture/replay                                                         |
| e. Tenant-scoped session/meter/status/ledger reads            | Done   | `/sessions`, `/sessions/:id`, `/stations/:id/status-events`, `/stations/:id/ingestion-events`, `/stations/:id/connectors`; E2E |

## NOT done / limitations

- SSE `GET /events` is Phase 2c.
- CitrineOS station drift reconciliation is not implemented.
- Offline timeout uses the configured timeout only; heartbeat interval is not
  yet persisted, so `max(config, 3×heartbeat)` is not fully implemented.
- Retention defaults are now per-tree (meter 365 d, status 90 d, ledger 30 d),
  but the final finance/legal and DPDP periods remain provisional.
- `SESSION_CONFLICT` is represented as a duplicate transaction response, not a
  separately ledgered conflict reason.
- Main-branch CI cannot contain this commit until the PR is merged; the links
  supplied with the review package are the PR CI and the current `main`
  baseline CI.

## Round 2 blocking/medium review map

Evidence: `docs/evidence/phase2b-review-red-first.log` (9 targeted tests failed on
`22b1082` before these fixes), `docs/evidence/phase2b-meter-dedup-explain.log`
(1,000,000-row EXPLAIN), `docs/evidence/phase2b-write-timings.log`, and
`docs/evidence/phase2b-e2e-review.log`.

| #   | Fix                                                                                  | Status                                            | Test / evidence                                                                            |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Retry dead-letters to default exchange/routing `evstation.ingest`, not `messages`    | Done                                              | `amqp-retry.live.test.ts`; queue definitions template                                      |
| 2   | Sequential prefetch=1 + awaited dispatcher                                           | Done                                              | `events.test.ts > awaits handlers in order`                                                |
| 3   | Thrown errors honour death count; poison ledger; timestamp validation                | Done                                              | `ingest.test.ts > parks thrown failure`; meter timestamp test                              |
| 4   | Relative session energy with non-zero meterStart                                     | Done                                              | `phase2b-review.test.ts > session energy`                                                  |
| 5   | Redelivered start response duplicate by correlation id                               | Done                                              | `phase2b-review.test.ts > redelivered start response`                                      |
| 6   | Shared liveness helper, revival, sweep timestamps, ordering                          | Done                                              | `phase2b-review.test.ts > liveness`; E2E out-of-order                                      |
| 7   | Tenant-aware meter dedup + `(session_id, charger_reported_at)` index                 | Done                                              | `session_meter_values_session_charger_idx`; EXPLAIN evidence                               |
| 8   | Graceful shutdown waits for serial chain before ack/close                            | Done (dedicated broker shutdown test still a gap) | `createSerialDispatcher` test; close awaits chain                                          |
| 9   | Advisory lock per job + in-process overlap guard                                     | Done                                              | `jobs.test.ts > allows only one runner`; `runJobs` guard                                   |
| 10  | Column-level definer grants; no table INSERT on connectors for app                   | Done                                              | 0033 grants; `rls.test.ts` matrix                                                          |
| 11  | Stale sessions use CSMS activity + station offline state                             | Done                                              | `phase2b-review.test.ts > stale sessions`                                                  |
| 12  | Expired pending starts post `START_RESPONSE_MISSING`                                 | Done                                              | `phase2b-review.test.ts > expired pending starts`                                          |
| 13  | Unknown units skipped, phase-less power sum, length caps, DB state validation        | Done                                              | `meter.test.ts`; `phase2b-review.test.ts` caps/state                                       |
| 14  | Queue max-length/TTL + committed definitions template                                | Done                                              | `infra/compose/rabbitmq/evstation-ingest-definitions.json`, runbook                        |
| 15  | AMQP error/close reflected in health                                                 | Done (no dedicated test)                          | worker `onState`, `/healthz`                                                               |
| 16  | Worker counters and consumer lag                                                     | Done (no dedicated test)                          | `/metrics`, `evstation_worker_consumer_lag`                                                |
| 17  | Platform-admin rejection read path + 30-day prune                                    | Done                                              | `/ingestion-rejections`, `prune_ingestion_rejections`                                      |
| 18  | Register/retry lock, pool concurrency, write timings, horizon+3, first-of-month drop | Partial: non-UTC jobs-path test not added         | `api.test.ts > station lock`, `phase2b-review.test.ts > first-of-month`, jobs horizon test |

Current per-workspace counts after round 2: db 98, api 76, worker 9,
csms-adapter 13 passed + 4 skipped, shared 1, dashboard 59; root 257 passed,
4 skipped.

## Round 3 merge-gate fixes

| #   | Fix                                                                | Status                                                               | Evidence                                                        |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Remove depth-drop; use 5 GiB byte cap + reject-publish/depth alert | Done                                                                 | `evstation-ingest-definitions.json`, provision script, RUNBOOK  |
| 2   | Monitoring-only RabbitMQ user; `queue_depth_available`, NaN not 0  | Done                                                                 | `evstation_monitor`, `/metrics`; benchmark reports available=1  |
| 3   | Retry live test waits for the message on `evstation.ingest`        | Done                                                                 | `amqp-retry.live.test.ts`, smoke log                            |
| 4   | AMQP close/error exits non-zero after 1 s                          | Done                                                                 | worker `onState` timer                                          |
| 5   | Advisory unlock failure destroys connection                        | Done                                                                 | `jobs.test.ts > destroys connection`                            |
| 6   | 200 msg/s × 60 s benchmark + timings + sharding ADR                | Partial: sustained ~173 msg/s, so ADR-0027 sharding plan is required | `phase2b-throughput.log`, `phase2b-write-timings.log`, ADR-0027 |

Known issues are recorded in `docs/DECISIONS.md` (heartbeat-derived timeout,
broker shutdown test, non-UTC jobs test, connectors UPDATE grants, energy
semantics, 200-meter cap, parked metric scope).
