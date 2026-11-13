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
  `membership_removed`, `tenant_suspended`, `site_scope_lost`,
  `token_expired`, `server_shutdown`, `backpressure`, `client_closed`.

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
