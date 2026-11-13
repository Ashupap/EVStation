# Phase 2c round-2 fix map

| Item                                                                    | Status       | Evidence                                                                                                                    |
| ----------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| B1 single-flight LISTEN reconnect + per-generation ping                 | Done         | `apps/api/test/sse.test.ts > remains single-listener after two backend terminations`; generation/ping code in `sse.ts`      |
| B2 ordered bounded re-read FIFO/queue/drop metric                       | Done         | `apps/api/test/sse-queue.test.ts`; `OrderedReReadQueue` in `sse.ts`                                                         |
| B3 job notifications proven; non-deliverable expire notify removed      | Done/removed | `packages/db/test/phase2c.test.ts > job functions emit`; `expire_pending_starts` now ledger-only (`START_RESPONSE_MISSING`) |
| B4 benchmark after 0034                                                 | Done         | `docs/evidence/phase2b-benchmark-2c.log`: 172.1 msg/s vs 173.4 (-0.75%, below 10%)                                          |
| B5 scope revocation/backpressure/BFF-abort/live SSE/N-stream load       | NOT DONE     | Acceptance rows 9–11 remain PARTIAL; no PASS claimed                                                                        |
| M1 status NOTIFY carries `connector_id`; re-read by connector/timestamp | Done         | 0034 payload; `phase2c.test.ts > status NOTIFY carries connector id`                                                        |
| M2 prefer tenant_admin actor, bounded fallback                          | Done         | `sse.ts processNotification`; stale actor fallback by distinct actor                                                        |
| M3 backpressure writes closed then destroys socket                      | Done         | `sse.ts closeConnection`                                                                                                    |
| M4 refresh errors keep stream; jitter timers; dead role branch removed  | Done         | `sse.ts refresh/scheduleRefresh`; role_demoted removed from API docs                                                        |
| M5 configurable meter interval + identical timestamp no re-notify       | Done         | worker `METER_NOTIFY_INTERVAL_S`; 0034 `current_setting`; existing throttle test                                            |
| Minor open cleanup/BFF failed upstream/hook 401 handling                | Partial      | open cleanup + BFF 502 done; hook session-expired handling remains                                                          |
| Remove duplicate 0034 ADD COLUMN                                        | Done         | 0034                                                                                                                        |
| S2 invisible/concurrent                                                 | Done         | `docs/evidence/phase2c-s2-rls-reread.log`                                                                                   |

| Extra: email_invalid refresh bug | Fixed | 930920e/acd4618; `sse-revocation.test.ts` membership_removed |
| Extra: close-frame flush | Fixed | dcecd83; raw transcript `phase2c-revocation-transcript.log` |
| Extra: harness chunk/keepalive bug | Fixed | 9524703; shared `SseStream` helper |
| Extra: per-connection write chain removed | Fixed | sync `sendRaw`; `sse-backpressure.test.ts` |
