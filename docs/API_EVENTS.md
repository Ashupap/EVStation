# `GET /events` and event schema (Phase 2c)

The browser connects to the same-origin dashboard BFF `GET /api/events` with the
opaque session cookie. The BFF opens the API `GET /events` with a server-side
Bearer token and `X-Tenant-Id`; no token is placed in a query string.

## SSE endpoint

```http
GET /events
Authorization: Bearer <server-side JWT>
X-Tenant-Id: <tenant UUID>
Accept: text/event-stream
Last-Event-ID: <optional event id>
```

Response: `200 text/event-stream`. Platform admins receive
`403 PLATFORM_ADMIN_NOT_SUPPORTED` in 2c. A missing/invalid token is `401`.
`Last-Event-ID` causes an immediate `event: resync`; events are not replayed.

## Frame format

```text
id: <event UUID>
event: station.status
data: {"version":1,"type":"station.status","tenant_id":"…","site_id":"…","station_id":"…","connector_number":1,"status":"charging","error_code":null,"csms_timestamp":"…","updated_at":"…"}
```

Control events:

- `event: resync` — after LISTEN reconnect or `Last-Event-ID`; refetch.
- `event: closed` — final event with `data.reason`:

| Reason                 | Meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `membership_removed`   | The actor no longer has a membership in the tenant                    |
| `tenant_suspended`     | The tenant is suspended                                               |
| `site_scope_lost`      | The actor lost access to a site it was receiving                      |
| `token_expired`        | The access token reached its `exp`                                    |
| `scope_refresh_failed` | Repeated scope-refresh errors, capped by `SSE_MAX_REFRESH_FAILURES`   |
| `server_shutdown`      | The API process is shutting down                                      |
| `backpressure`         | The client did not read fast enough; the per-connection buffer filled |
| `client_closed`        | The client disconnected                                               |
| `client_error`         | The connection errored                                                |
| `write_error`          | Writing the frame to the socket failed                                |

`membership_removed`, `tenant_suspended` and `site_scope_lost` are terminal:
the browser closes the stream and does not reconnect. `token_expired`,
`server_shutdown`, `backpressure` and `scope_refresh_failed` reconnect with
jitter, so a client that only treats the first three as terminal will
reconnect after a failed scope refresh.

## Event kinds and data

| Event                                                   | Data fields                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `station.connection`                                    | `tenant_id`, `site_id`, `station_id`, `connection_state`, `last_seen_at`, `last_event_csms_at`, `updated_at`                                |
| `station.status`                                        | `tenant_id`, `site_id`, `station_id`, `connector_number`, `status`, `error_code`, `csms_timestamp`, `updated_at`                            |
| `session.started` / `session.updated` / `session.ended` | `tenant_id`, `site_id`, `station_id`, `session_id`, `status`, `stop_reason`, `energy_wh` (relative), `started_at`, `ended_at`, `updated_at` |
| `session.meter`                                         | `tenant_id`, `site_id`, `station_id`, `session_id`, `status`, `energy_wh` (relative), `updated_at`                                          |

No `idTag`, token, or raw OCPP payload is ever sent. `updated_at` is present on
every data object; clients apply last-write-wins per entity and preserve FIFO
ordering per `session_id`/`station_id`. `session_meter_values.energy_wh` remains
the cumulative register; the event's `energy_wh` is `sessions.energy_wh`.
