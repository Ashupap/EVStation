# EVStation CMS: project guide for Claude Code

India EV-charging Central Management System (CMS) built on CitrineOS. Repo: Ashupap/EVStation.
Owner is a non-engineer product owner; an independent reviewer ("architect") checks work at gates.

## Current state (update this section at every phase tag)

- Phase 0 (foundation, simulator, CI): done, tag `phase-0-complete`
- Phase 1 (auth, tenants, RLS, API, dashboard): done, tag `phase-1-complete`
- Phase 2a (station registry, CitrineOS adapter, rotation): done, tag `phase-2a-complete` (76cdfc0)
- Phase 2b (AMQP ingestion worker, sessions, retention, partitions): done, tag `phase-2b-complete` (39a8828)
- Phase 2c (SSE `GET /events`, scope refresh, docs, acceptance): done, tag `phase-2c-complete` (192d523)
- OPEN: follow-up PR `phase2c-evidence` (live latency + 200-stream load evidence, rows 9c and 11 in
  docs/PHASE2_ACCEPTANCE.md), branch `phase2c-evidence`. Do NOT tag `phase-2-complete` until it is
  reviewed and merged.
- Next: Phase 3 (dashboard pages), then remote commands (Phase 4), alerts, driver app, trip advisor,
  OCPI, payments, telematics, surveillance.
- Latest migration is 0034. Numbering gap at 0028 is intentional; never reuse it. New migrations start at 0035.

## Stack and pins (do not change without an ADR)

- CitrineOS v2.1.0 pinned at commit 4fd7599b91c2fb6e6065e7c9b94be69880cced27 (OCPP 1.6J only for now)
- Node 24.22.2, pnpm 10.30.3, TypeScript 5.9.3, Vitest 5.0.5, amqplib 2.2.0, pg 8.23.1
- Postgres/PostGIS 16, RabbitMQ (topic exchange `messages`), Hasura 2.40.3, Keycloak (realm `evstation`)
- Ports: CitrineOS HTTP 8088, OCPP WS 8081 (no auth, local only) / 8082 (Basic auth), API 4000,
  dashboard 3200, Hasura 8090, Keycloak 8180, worker health 4100
- Apps: apps/api (Fastify + Zod), apps/worker (AMQP ingestion), apps/dashboard (Next.js);
  packages/db (SQL migrations + tests), packages/csms-adapter

## Architecture rules (security and correctness; these have caught real bugs)

- Multi-tenancy by Postgres FORCE RLS. All tenant reads go through tenant-scoped, RLS-enforced paths.
  Routes are in a registry with a fail-closed isolation suite; every new route must be added to it.
- DB roles: `evstation_app` (API), `evstation_owner` (migrator), `evstation_definer`,
  `evstation_ingest` (execute-only), `evstation_ingest_definer`, `evstation_event_owner`,
  `evstation_jobs`. SECURITY DEFINER functions pin `search_path`; EXECUTE revoked from PUBLIC;
  column-level grants. Do not widen grants without an ADR.
- Worker: separate process, `prefetch(1)`, ack only after DB commit, broker-native retry, ledger for
  rejected/parked events only. Throughput measured ~172 msg/s; sharding plan is ADR-0027.
- SSE: scope loaded once per connection, refreshed every 30 s, FAIL CLOSED (access-denied errors close
  the stream; only classified transient errors are retried, capped). NOTIFY carries IDs only; one
  RLS re-read per NOTIFY; fan-out by in-memory tenant/site filter taken from the re-read row.
  Platform admin gets 403 on /events (acting-as is deferred, ADR-0018).
- Never log idTag, tokens or secrets. No admin secrets in app code. Mask idTag as `****` + last 4.
- Never edit a migration after it has been applied to any non-throwaway database; use a throwaway DB
  or reset during PR work. If a shipped migration must change, add a new one.
- Keep `/metrics` protected (METRICS_TOKEN). Worker health endpoints bind 127.0.0.1.

## Working process (non-negotiable)

1. Large or risky work: write a design note in docs/design/, run spikes, then STOP and wait for
   "APPROVED" before implementing.
2. Implement in small reviewable commits on a branch; open a PR.
3. Never merge a PR and never create a phase tag until the owner says "APPROVED TO MERGE".
   (A past phase was merged before review; do not repeat this.)
4. Never weaken, delete or skip a failing test to get green. Commit the failing test first, then the fix.
5. Never fabricate evidence or logs. If a run cannot be done, say so and say why.
6. Docs must match reality in the same PR: acceptance matrix, KNOWN_ISSUES, RUNBOOK, ADRs. Verify claims
   against the repo files, not against earlier summaries or zip copies.
7. A fix reported as done must be present in the final code: re-read the final diff before saying so.
8. Run before every push: pnpm install --frozen-lockfile, lint, format:check, typecheck, test, test:db.
   Run smoke / E2E for ingestion or SSE changes. Report real numbers.
9. Review package for the owner at each gate: README, diff, CI and smoke logs, new evidence, and a table
   mapping each requirement to commit and test.
10. When unsure about a decision that is the owner's (scope, cost, legal, retention), ask.

## Known issues

The full, authoritative list lives in docs/KNOWN_ISSUES.md. Do not duplicate it here; read that file
before planning work, and update it in the same PR as any fix or new finding.

## Reference docs

docs/DECISIONS.md (ADRs), docs/RUNBOOK.md, docs/PHASE2_ACCEPTANCE.md, docs/KNOWN_ISSUES.md,
docs/API_EVENTS.md, plus the `docs/design` and `docs/evidence` directories.
