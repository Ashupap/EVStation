# Known issues

Consolidated Phase 1 and Phase 2 issues. Severity is relative to a local/pilot
deployment; owner phase is the phase expected to close it.

| Severity | Phase | Issue                                                                                             | Workaround / decision                                                              |
| -------- | ----- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| High     | 0     | OCPP profile 0 and CitrineOS `localDev` HTTP auth are dev-only; do not expose beyond localhost    | Keep 127.0.0.1 bindings; RUNBOOK "OCPP WebSocket exposure"                         |
| High     | 1     | Dashboard sessions/login transactions/rate-limit buckets are in-process                           | Single replica; restart requires re-login; shared store before scaling             |
| Medium   | 1     | Platform-admin impersonation / acting-as is not implemented                                       | ADR-0018; use tenant-scoped admin flows                                            |
| Medium   | 2a    | Phase 1 tenant/site creation APIs do not require org/site codes                                   | Station creation rejects missing codes; backfill/API hardening remains OPEN        |
| Medium   | 2b    | Heartbeat-derived offline timeout is not implemented; sweeper uses configured timeout only        | Commission with boot heartbeat interval <= timeout/3 (RUNBOOK)                     |
| Medium   | 2b    | Retention periods remain provisional (meter 12 months, status 90 d, ledger 30 d, idTag 12 months) | OPEN for finance/legal/DPDP owner; defaults are configurable                       |
| Medium   | 2b    | Connector `UPDATE` table grants were intentionally removed by 0033                                | A future connector PATCH route must add explicit column grants (Phase 3)           |
| Medium   | 2b    | `session_meter_values.energy_wh` is the cumulative register; `sessions.energy_wh` is relative     | API/event docs state the difference; do not compare directly                       |
| Low      | 2b    | `/sessions/:id` meter list is capped at 200                                                       | Add pagination if the UI needs history                                             |
| Low      | 2b    | `evstation_worker_events_parked_total` excludes `RETRY_EXHAUSTED`                                 | Ledger is authoritative; metric fix is pending                                     |
| Medium   | 2b    | Sustained ingestion is ~173 msg/s vs 200 target with prefetch(1)                                  | ADR-0027 sharding plan before the 500-station target                               |
| Low      | 2c    | SSE Last-Event-ID has no replay                                                                   | Send `resync`; client refetches after reconnect                                    |
| Low      | 2b    | No non-UTC jobs-path test                                                                         | Jobs use UTC month boundaries; add process-TZ test                                 |
| Low      | 2c    | EventSource hook does not yet map BFF 401 to a dedicated session-expired UI                       | Stream closes and page/auth state must be refreshed; hook-level messaging deferred |
| Medium   | 2c    | SSE load and live-latency evidence not yet produced (rows 9c, 11); caps and metrics in place      | Follow-up PR phase2c-evidence                                                      |
