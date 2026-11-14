# Phase 2c design: realtime events (SSE)

Status: **design + spikes only — implementation is blocked until `APPROVED`**.
Baseline: `main` at `39a8828` / tag `phase-2b-complete`.
Migration policy: additive from `0034`; `0020`–`0033` are immutable. The
repository has an intentional numbering gap at `0028`; it is not reused.

## 1. Proposal in one paragraph

The dashboard keeps its opaque server-side session and adds a same-origin BFF
route `GET /api/events`. That route authenticates the cookie, refreshes the
session token server-side, and opens a streaming request to the API
`GET /events` with `Authorization: Bearer …`. The API holds the caller scope
(tenant, role, site ids, token expiry) in memory for the connection, runs one
dedicated PostgreSQL `LISTEN evstation_events` client, and re-reads every
affected row through `evstation_app` with RLS before fan-out. PostgreSQL
NOTIFY carries IDs only. Notifications are emitted inside the existing
SECURITY DEFINER ingest/job functions in the same transaction as the write.
No token is ever put in a query string.

## 2. Event flow

```text
CitrineOS / worker                 PostgreSQL                      API process
      │                                │                               │
      │ ingest_* (definer)             │                               │
      ├───────────────────────────────▶│ UPDATE/INSERT                 │
      │                                │ PERFORM app.notify_event(ids) │
      │                                │ NOTIFY evstation_events       │
      │                                ├──────────────────────────────▶│ LISTEN client
      │                                │                               │ parse IDs only
      │                                │◀──────────────────────────────┤ one RLS re-read
      │                                │  app role + scope GUC         │
      │                                │──────────────────────────────▶│ visible row?
      │                                │                               │ yes: fan out local
      │                                │                               ├──▶ SSE clients
      │                                │                               │ no: drop
```

Sequence, including scope refresh and reconnect:

```text
Browser EventSource   Dashboard BFF       API /events          LISTEN        PostgreSQL
      │                    │                   │                  │              │
      ├─ GET /api/events ─▶│                   │                  │              │
      │  cookie            ├─ Bearer token ───▶│                  │              │
      │                    │                   ├─ auth + scope ──┼─────────────▶│
      │◀─ 200 stream ──────┤◀─ 200 stream ─────┤                  │              │
      │                    │                   ├─ LISTEN ────────▶│              │
      │                    │                   │                  │              │
      │                    │                   │◀─ NOTIFY ids ────┤◀─ commit ────┤
      │                    │                   ├─ one RLS read ───┼─────────────▶│
      │◀─ event: station ──┤◀─ event: station ─┤                  │              │
      │                    │                   │                  │              │
      │                    │                   ├─ every 30s scope revalidate ───▶│
      │                    │                   │  removed/demoted/suspended/…    │
      │◀─ event: closed ───┤◀─ event: closed ──┤                  │              │
      │                    │                   │                  │              │
      │  EventSource reconnects with fresh dashboard session token │              │
```

If the LISTEN connection drops, the API reconnects with exponential backoff and
sends every live stream `event: resync`. Missed events are **not replayed**;
the dashboard refetches the affected page/query on `resync`.

## 3. Auth transport

- Browser: `EventSource('/api/events')`, same-origin. EventSource cannot set an
  Authorization header, so the browser never attempts to send a token.
- Dashboard BFF: reads the HttpOnly, SameSite=Lax session cookie
  (`evstation_session` / `__Host-…` in production), refreshes the access token
  server-side if needed, and calls the API with a server-only Bearer token.
  This is the same trust boundary as every dashboard page.
- CSRF/origin: the BFF validates the initial request origin using the existing
  `hasValidOrigin` helper and relies on SameSite=Lax + HttpOnly; the stream is a
  read-only GET and never changes state. No token, session id, or CSRF value is
  accepted in the query string. Cross-origin EventSource is not supported by
  this route.
- BFF response headers: `content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `x-accel-buffering: no`,
  `connection: keep-alive`; compression must be disabled for this route.
- The API still verifies the JWT issuer/audience/signature/expiry; the BFF
  does not invent a second authorization mechanism.

## 4. Scope lifecycle

At connect the API loads the principal and tenant scope once (same
`loadPrincipal`/membership/tenant-status path as HTTP routes) and stores:

```text
{ sub, tenantId, role, siteIds:Set, tokenExpiresAt, connectionId }
```

- A single timer per connection revalidates scope every **30 s** (one DB
  transaction, not per event).
- The stream closes with a final `event: closed` and `data: {"reason":"…"}`
  when any of these is observed:
  - membership removed
  - role demoted below `viewer`/the capability needed to read stations
  - tenant suspended
  - any previously allowed site id is no longer in the membership site scope
  - access token reached its `exp` timestamp
- `reason` values: `membership_removed`, `tenant_suspended`,
  `site_scope_lost`, `token_expired`, `scope_refresh_failed`,
  `server_shutdown`, `backpressure`, `client_closed`, `client_error`,
  `write_error`.
  A role change that narrows scope is not a close reason: the refreshed
  scope is applied and the stream narrows to the sites it can still see.
- Token expiry is explicit: the API closes with `token_expired`; the browser
  must obtain a fresh dashboard session/token and reconnect. EventSource's
  automatic reconnect alone must not be treated as a new authorization.
- Scope is never recomputed from event data. The in-memory scope filters and
  the RLS re-read both use the same tenant/site values.

## 5. NOTIFY contract

Channel: `evstation_events`.

Payload is a small JSON object containing identifiers and the event timestamp
only; no row payload, no `idTag`, no names, no meter values:

```json
{
  "v": 1,
  "id": "2e8c72c9-1b1f-4b31-a7de-4d7a9b9d8b91",
  "kind": "station.status",
  "tenant_id": "10000000-0000-4000-8000-000000000001",
  "site_id": "20000000-0000-4000-8000-000000000001",
  "station_id": "30000000-0000-4000-8000-000000000001",
  "session_id": null,
  "occurred_at": "2026-11-13T03:00:00.123Z",
  "event_ref": "frame:inbound:StatusNotification:<corr>:0"
}
```

This is ~500 bytes, far below PostgreSQL's 8000-byte NOTIFY limit. `event_ref`
is an opaque dedup/correlation string already generated by ingestion; it is
not PII. No normal heartbeat is notified.

Emission happens inside the existing SECURITY DEFINER functions, in the same
transaction as the state change. A rollback therefore emits nothing; S1 proves
this. The functions remain owned by `evstation_ingest_definer`; the helper is
also owned by that role and is not granted to app/ingest/browser roles. The app
only needs `LISTEN`/`SELECT` on the channel's NOTIFY delivery (PostgreSQL
LISTEN requires no table grant). The worker grants are unchanged except a
strictly necessary `UPDATE (last_meter_notify_at)` on sessions.

## 6. Re-read and fan-out

For every NOTIFY the API performs exactly **one** RLS-scoped re-read of the
affected row, using the in-memory scope, for example:

- `station.connection` → `app.station_runtime_state` by `station_id`
- `station.status` → `app.station_status_events` by event id/station id
- `session.started|updated|ended|superseded` → `app.sessions` by `session_id`
- `session.meter` → `app.sessions` by `session_id` (latest relative energy)

The read runs as `evstation_app` with `app.actor_id` and `app.tenant_id` set;
RLS is the final authority. If the row is not visible, the event is dropped.
The NOTIFY payload is never forwarded as event data. Fan-out is local to the
API process after the visible row is serialized with the versioned event
schema. This avoids per-event authorization DB calls while retaining RLS.

Measured S2 cost on local PostgreSQL 16 (1000 iterations, app role, set GUCs,
one row): p50 **6.07 ms**, p95 **9.38 ms**, max 19.46 ms
(`docs/evidence/phase2c-s2-rls-reread.log`). Combined with the 5 s meter
throttle, this is acceptable for the pilot event rate; sharding is tracked in
ADR-0027.

## 7. Event kinds and throttle

| kind                 | emitted when                                       | source row re-read |
| -------------------- | -------------------------------------------------- | ------------------ |
| `station.connection` | connected/closed transition only                   | runtime state      |
| `station.status`     | connector/station StatusNotification               | status event       |
| `session.started`    | accepted StartTransaction response                 | session            |
| `session.updated`    | supersede/failed transition                        | session            |
| `session.ended`      | StopTransaction or stale close                     | session            |
| `session.meter`      | meter update, **at most once per 5 s per session** | session            |

No NOTIFY for plain heartbeat, accepted meter rows without a throttle slot, or
ordinary BootNotification. Throttle is per session and persisted as
`sessions.last_meter_notify_at` so multiple API/worker instances agree. Five
seconds matches the simulator/typical OCPP meter cadence and keeps the UI
useful without turning every meter row into an authorization read.

## 8. Event schema (v1)

SSE frame:

```text
id: 2e8c72c9-1b1f-4b31-a7de-4d7a9b9d8b91
event: station.status
data: {"version":1,"type":"station.status","occurred_at":"2026-11-13T03:00:00.123Z","tenant_id":"…","site_id":"…","station_id":"…","data":{"connector_number":1,"status":"charging","error_code":null}}
```

```text
event: session.meter
data: {"version":1,"type":"session.meter","occurred_at":"…","tenant_id":"…","site_id":"…","station_id":"…","session_id":"…","data":{"energy_wh":500,"status":"active"}}
```

- `id` is the NOTIFY event id, used for client-side dedup only. Last-Event-ID
  replay is out of scope: there is no event log and clients refetch after
  `resync`/reconnect.
- `data.energy_wh` for `session.meter` is the **relative** session energy
  (`sessions.energy_wh`), not the cumulative meter register. This is documented
  in OpenAPI/API docs; `session_meter_values.energy_wh` remains the register.
- `session.started/ended` include status/stop reason but never `idTag`.
- `event: closed` always carries a reason; `event: resync` carries no tenant
  data and tells the client to refetch.

## 9. Backpressure, limits, proxy

- Per-connection bounded outbound queue, cap **256 KiB** (configurable). If a
  write would exceed the cap, send `event: closed` reason `backpressure` if
  possible, then destroy the response and release all resources. A slow
  consumer never blocks other connections because writes are serialized per
  connection and fan-out uses a bounded local queue.
- Max connections: **10 per user**, **250 per tenant** (configurable). Excess
  connections get HTTP 429 with `Retry-After`.
- Keep-alive comment `: keepalive\n\n` every **15 s**.
- Proxy: disable buffering/compression for `/api/events` and `/events`
  (`X-Accel-Buffering: no`, `proxy_buffering off`, `gzip off`); document nginx
  equivalents in RUNBOOK.
- Graceful shutdown: stop accepting new streams, send `closed` reason
  `server_shutdown`, end all responses, stop timers, then close the LISTEN
  client and DB pool. The process waits up to 5 s for writes/cleanup.
- No SSE data is stored; no per-event DB authorization calls.

## 10. Multi-instance and reconnect

Every API instance opens its own dedicated `LISTEN evstation_events` client
(not a pooled connection), so every instance receives every NOTIFY and fans out
only to its local connections. No cross-instance bus is needed. On LISTEN
disconnect, reconnect with exponential backoff (1 s → 30 s, jitter), then send
`event: resync` to all local streams. Events missed while disconnected are not
replayed. This is deliberate and matches the client refetch contract.

## 11. Cross-tenant and cross-site safety

Two independent gates:

1. The in-memory filter requires `tenant_id` equality and (for site-scoped
   roles) `site_id ∈ scope.siteIds`.
2. The RLS re-read runs as `evstation_app` with only the connection's tenant
   GUC; a row outside scope returns no row and the event is dropped.

Tests must cover a second tenant and an out-of-scope site, including a NOTIFY
for a station the user's site scope excludes. A connection must never receive
another tenant's event even if the NOTIFY payload is spoofed with a foreign
tenant id.

## 12. Migration 0034 (merged as part of `phase-2c-complete`)

Numbering starts at `0034`; `0028` remains an intentional gap. The shipped
file is `packages/db/sql/0034_phase2c_sse_notifications.sql`. It adds
`sessions.last_meter_notify_at`, the plain `LANGUAGE sql` `notify_event`
helper (no `SECURITY DEFINER`, owned by `evstation_ingest_definer`, no event_ref
in the payload), the atomically throttled meter update, and notify call sites
for connection transitions, status, session start/update/end/meter, sweep and
stale close. Existing ingest/job functions keep their 0032/0033 owners. The
function-body diff evidence is
`docs/evidence/phase2c-0034-function-diff.log`, regenerated from the shipped
migrations with `packages/db/scripts/function-diff.mjs`; all existing DB tests
pass unmodified.

Two details differ from the original sketch below, and the shipped file is
the reference: `notify_event` takes a `p_connector_id` argument so a status
event can name its connector, and the meter throttle computes the decision
before the `UPDATE` rather than reading it back with `RETURNING`.

```sql
ALTER TABLE app.sessions ADD COLUMN IF NOT EXISTS last_meter_notify_at timestamptz;
GRANT UPDATE (last_meter_notify_at) ON app.sessions TO evstation_ingest_definer;

CREATE OR REPLACE FUNCTION app.notify_event(
  p_kind text, p_tenant_id uuid, p_site_id uuid, p_station_id uuid,
  p_session_id uuid, p_occurred_at timestamptz,
  p_connector_id uuid DEFAULT NULL, p_event_id uuid DEFAULT gen_random_uuid()
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT pg_notify('evstation_events', jsonb_build_object(
    'v', 1, 'id', p_event_id, 'kind', p_kind,
    'tenant_id', p_tenant_id, 'site_id', p_site_id,
    'station_id', p_station_id, 'session_id', p_session_id,
    'connector_id', p_connector_id, 'occurred_at', p_occurred_at
  )::text)
$$;
ALTER FUNCTION app.notify_event(text,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid)
  OWNER TO evstation_ingest_definer;
REVOKE ALL ON FUNCTION app.notify_event(text,uuid,uuid,uuid,uuid,timestamptz,uuid,uuid) FROM PUBLIC;

-- Meter throttle: the decision is computed first, then one atomic UPDATE:
v_should_notify :=
  (sess.last_meter_notify_at IS NULL OR
   sess.last_meter_notify_at <= p_csms_timestamp
     - make_interval(secs => coalesce(nullif(current_setting('evstation.meter_notify_interval_s', true), '')::int, 5)))
  AND greatest(sess.energy_wh, greatest(0, v_max_energy - sess.meter_start_wh)) IS DISTINCT FROM sess.energy_wh;
UPDATE app.sessions
SET energy_wh = greatest(energy_wh, greatest(0, v_max_energy - sess.meter_start_wh)),
    last_meter_notify_at = CASE WHEN v_should_notify THEN p_csms_timestamp ELSE last_meter_notify_at END,
    updated_at = now()
WHERE id = sess.id;
IF v_should_notify THEN
  PERFORM app.notify_event('session.meter', sess.tenant_id, sess.site_id,
    sess.station_id, sess.id, p_csms_timestamp);
END IF;
```

`expire_pending_starts` is deliberately ledger-only: it parks an expired start
request but emits no event, because a start that never got a response has no
session to report.

## 13. Spikes (completed)

| Spike | Question                                  | Result / evidence                                                                                                                                                                                                    |
| ----- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | NOTIFY inside definer + rollback          | Rollback delivered 0; commit delivered 1: `docs/evidence/phase2c-s1-notify-rollback.log`                                                                                                                             |
| S2    | One RLS re-read cost under load           | 1000 iterations, p50 6.07 ms, p95 9.38 ms: `docs/evidence/phase2c-s2-rls-reread.log`                                                                                                                                 |
| S3    | SSE through dashboard auth path/dev proxy | Test-login cookie → Next.js streaming route through a Node reverse proxy; chunks 0/1/2 at ~0.9/1.4/1.9 s; `text/event-stream`, `no-transform`, `x-accel-buffering: no`: `docs/evidence/phase2c-s3-sse-dashboard.log` |
| S4    | LISTEN reconnect + resync                 | before-disconnect and after-reconnect delivered; while-disconnected missed; explicit resync emitted: `docs/evidence/phase2c-s4-listen-reconnect.log`                                                                 |

## 14. Tests to add (after approval)

- Route registry includes `GET /events`; unauthenticated fails 401; every
  tenant-scoped read path remains fail-closed.
- Tenant B event and tenant-A out-of-scope-site event are never delivered.
- Scope revocation: membership removed, role demoted, tenant suspended, site
  scope removed, token expired → `closed` within one 30 s refresh interval.
- Rollback: transaction NOTIFY + rollback delivers nothing.
- Heartbeat: plain heartbeat produces no NOTIFY.
- Backpressure: slow consumer gets closed and other streams continue.
- Live: simulator → worker → NOTIFY → `/events` client with measured latency;
  evidence in `docs/evidence/`.
- Load: N concurrent streams with a steady ingest rate; report API CPU,
  memory, re-read count per event, and backpressure disconnects.
- Dashboard BFF E2E through test-login and EventSource/fetch-streaming.

## 15. Task list and commit plan (after APPROVED)

1. `0034` additive migration (column + notify helper + function bodies), DB
   tests for rollback, heartbeat silence, throttle, and event payload IDs.
2. API LISTEN broker + scope cache/refresh + RLS re-read + `/events` route and
   isolation/revocation/backpressure tests.
3. Dashboard BFF `/api/events` streaming route + EventSource client and UI
   opt-in; auth/origin tests.
4. Worker/job notification call sites and live simulator E2E evidence.
5. Load/backpressure evidence; RUNBOOK + OpenAPI/event schema docs.
6. Phase 2 acceptance, consolidated KNOWN_ISSUES, ADR-0028+.
7. Review zip and STOP for `APPROVED TO MERGE`.

## 16. Phase 1 housekeeping answers

- PR #2 was merged; `phase-1-complete` is tagged.
- There is no dedicated platform-admin “acting as” ADR; ADR-0018 explicitly
  keeps impersonation out of Phase 1 scope (only the audit marker exists).
- The Phase 1 known-issues list is not yet consolidated; Phase 2c creates
  `docs/KNOWN_ISSUES.md` with both phases.
- `gitleaks` was run over full history on 2026-11-13: 69 commits scanned, no
  leaks found (`docs/evidence/gitleaks-report.json`, `gitleaks-run.log`).
- The `returnTo` open-redirect check is covered by
  `apps/dashboard/test/e2e/dashboard.spec.ts` (malicious `//evil.example`) and
  `apps/dashboard/test/csrf.test.ts`; both pass in CI. No separate manual
  browser result is recorded.

## 17. Open questions for approval

1. Meter throttle: 5 s per session (proposed) vs 10 s.
2. Connection caps: 10/user and 250/tenant (proposed).
3. BFF path `/api/events` and client reconnect policy after `token_expired`.
4. Whether `session.meter` should include only relative energy or both
   relative and cumulative register (proposal: relative only, with field docs).
5. Whether to add a small event-log/Last-Event-ID replay later; currently
   explicitly out of scope.
6. Nginx/ingress buffering configuration ownership for deployed environments.

## 18. Approved amendments (binding, 2c implementation)

This section is part of the approved design and overrides any conflicting
wording above. Implementation follows these amendments exactly.

### A1. Re-read scope and spoofed NOTIFY

- The API runs the one re-read per NOTIFY as `evstation_app`, with exactly
  `app.actor_id = <connection principal sub/actor id>` and
  `app.tenant_id = <NOTIFY tenant_id>`. It does not use a definer role or the
  payload's station/site as authorization.
- Fan-out uses the **re-read row's** `tenant_id` and `site_id`, never the
  payload's tenant/site. RLS is the tenant gate; the in-memory site scope is the
  site gate.
- If the re-read returns no row, drop the event and increment
  `events_dropped_not_visible`.
- Test: publish a spoofed NOTIFY with tenant B's tenant_id for tenant A's
  connection; nothing is delivered.

### A2. Platform admin on /events

- `GET /events` returns **403 `PLATFORM_ADMIN_NOT_SUPPORTED`** for platform
  admins in 2c. Add ADR-0028: acting-as remains deferred (ADR-0018), and SSE is
  tenant-scoped only.
- Test the exact status/code for a platform-admin token.

### A3. LISTEN/commit coupling and health

- The LISTEN connection is a dedicated client and never runs in a transaction.
- Export `pg_notification_queue_usage()` as `evstation_worker_notification_queue_usage`
  (or `evstation_api_notification_queue_usage`) and alert at >50%.
- Detect half-open LISTEN connections with a periodic `SELECT 1` ping (e.g.
  every 15 s) or TCP keepalive; reconnect with backoff and send `resync` only
  after the new LISTEN is confirmed.
- Re-run `tools/phase2b-benchmark.mjs` against 0034 and publish before/after
  delta. If mixed-event throughput drops >10%, stop and report.

### A4. Close/reconnect and BFF leak behaviour

- Terminal reasons `membership_removed`, `tenant_suspended`,
  `site_scope_lost`: the browser calls `EventSource.close()` and shows an
  explanation; it does not auto-reconnect.
- `token_expired` and `server_shutdown`: reconnect with jittered backoff.
- BFF sends `retry:` with jitter, returns 401 when the dashboard session is
  gone, and aborts the upstream API request when the browser disconnects
  (leak test).
- Browser disconnect must abort the upstream request; no orphan API stream.

### A5. Token expiry timer

- On connect, schedule a close timer at the JWT `exp` (not only the 30 s
  refresh). Send `event: closed` with `token_expired` at expiry and let the
  client reconnect with a fresh dashboard session.
- Document accepted revocation latency: up to 30 s refresh interval plus
  jitter.

### Last-Event-ID and resync

- A request carrying `Last-Event-ID` gets `event: resync` first (no replay).
- On LISTEN reconnect, send `resync` only after the new LISTEN is confirmed.
- No event replay/log is added.

### Snapshot events and ordering

- Every event data object includes `updated_at`.
- Events are state snapshots; the client applies last-write-wins by
  `updated_at` per entity.
- Preserve per-session/per-station ordering with a FIFO keyed by
  `session_id`/`station_id`, bounded concurrency; do not reorder within a key.
- Exact data fields:
  - `station.connection`: `connection_state`, `last_seen_at`,
    `last_event_csms_at`, `updated_at`
  - `station.status`: `connector_number`, `status`, `error_code`,
    `csms_timestamp`, `updated_at`
  - `session.started|updated|ended`: `status`, `stop_reason`, `energy_wh`
    (relative), `started_at`, `ended_at`, `updated_at`
  - `session.meter`: `status`, `energy_wh` (relative), `updated_at`
- No `idTag`, masked or raw, ever appears in any event.

### notify_event and job call sites

- `notify_event` is plain `LANGUAGE sql` (not SECURITY DEFINER) and is not
  granted to ingest/app/browser roles. It accepts IDs only; `event_ref` is
  dropped from the NOTIFY payload (the row's id/kind/tenant/site/station/
  session/occurred_at/updated_at is sufficient).
- Add job call sites:
  - `sweep_offline_stations` → `station.connection` offline
  - `close_stale_sessions` → `session.ended`
  - `expire_pending_starts` → `session.updated`
- Prove the owner/grantee of each job function can call `notify_event` (same
  owner chain as 0032/0033).

### Throttle

- Use one atomic
  `UPDATE app.sessions SET last_meter_notify_at=$ts WHERE id=$id AND (last_meter_notify_at IS NULL OR last_meter_notify_at <= $ts - make_interval(secs => $METER_NOTIFY_INTERVAL_S)) RETURNING ...`.
- NOTIFY only when a row is returned. Config `METER_NOTIFY_INTERVAL_S` default
  `5`. Do not notify when `energy_wh` is unchanged.
- Confirm the worker owner has the column-level UPDATE grant for
  `last_meter_notify_at`.

### Migration 0034 review requirements

- Additive from 0034; do not edit 0020–0033. `0028` remains a documented gap.
- Show a diff of every replaced function body against its 0032/0033 version
  proving only notify/throttle additions (plus the necessary
  `last_meter_notify_at` update).
- Same OWNER pattern as 0032: ingest functions stay owned by
  `evstation_ingest_definer`; job functions keep their existing owner.
- All existing DB tests must pass **unmodified**.

### No pool per stream and bounded re-read

- Never hold a pooled DB connection for the lifetime of an SSE stream; the only
  long-lived DB client is the dedicated LISTEN client.
- Use a bounded re-read pool and bounded queue; on overflow drop with a metric
  (`events_dropped_queue_full`) rather than unbounded growth.
- Coalesce the 30 s scope refresh per user where cheap (one query per user per
  interval, shared by that user's connections).

### Metrics and limits

- Export: `sse_connections`, `events_notified`,
  `events_dropped_not_visible`, `reread_ms` p50/p95, `resyncs`,
  `backpressure_closes`, `notification_queue_usage`.
- Limits: 10/user, 250/tenant, 2,000 per API process, checked against the
  process fd limit at startup. Document per-instance semantics.
- /api/events is the BFF path; reconnect policy as in A4.

### Additional evidence

- S1: re-prove inside real `ingest_*` functions after 0034.
- S2: add invisible-row (wrong tenant) and concurrent cases; state expected
  re-read rate (~30% of ingest) and pool sustainable maximum.
- S3: repeat against `next build` + `next start` with real cookie auth and
  prove client abort reaches upstream.
- S4: add half-open LISTEN detection/reconnect.
- Ingress: platform/infra owner owns buffering; app sets headers; RUNBOOK
  contains nginx config; deploy-time smoke asserts first chunk <2 s.
- Manual `returnTo` browser check recorded in PHASE2_ACCEPTANCE; automated
  tests remain primary.
- Run full-history gitleaks before opening the implementation PR and attach the
  report; stop and report any finding.

### Open-question resolutions

1. Meter throttle 5 s configurable.
2. Limits 10/user, 250/tenant, 2,000/process; per-instance.
3. BFF `/api/events`; reconnect policy per A4.
4. `session.meter` relative energy only, plus `updated_at`.
5. No replay; `Last-Event-ID` triggers `resync`.
6. Buffering owned by platform/infra; app headers + RUNBOOK nginx config +
   deploy smoke <2 s first chunk.

### Round-2 implementation notes (binding)

- Status NOTIFY includes `connector_id`; status re-read matches connector/timestamp.
- Re-read prefers a `tenant_admin` connection, then site_manager/viewer; a stale actor is skipped within a bounded distinct-actor fallback.
- `expire_pending_starts` no longer emits SSE; it remains ledger-only `START_RESPONSE_MISSING` because a NULL session id is intentionally dropped by reread.
- Meter notify interval is read from `evstation.meter_notify_interval_s`; the worker sets it from `METER_NOTIFY_INTERVAL_S` (default 5).
- LISTEN reconnect is single-flight with a generation token, per-client ping, and handler removal.
