# Phase 2b review map

Implementation commit: `1b7ffcd7336001fbc8846166d5b48d78dd479aaf`

Status: implementation + review fixes complete locally; not yet merged.

## Evidence

- Full test suite: `pnpm test` — 27 files passed, 1 skipped; 241 tests passed, 3 skipped.
- Per-workspace counts from `pnpm vitest run <dir>`:
  - `packages/db/test`: 5 files, 89 passed
  - `apps/api/test`: 6 files, 75 passed
  - `apps/worker/test`: 2 files, 5 passed
  - `packages/csms-adapter/test`: 4 passed + 1 skipped files; 12 passed + 3 skipped tests
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
