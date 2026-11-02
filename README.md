# EVStation

An EV charging Central Management System (CMS) for India, built on top of
[CitrineOS](https://github.com/citrineos/citrineos-core) (open-source OCPP 2.0.1 & 1.6 CSMS).

Work is phased; see `PRD.md` for the full product requirements and
`docs/RUNBOOK.md` for setup once Phase 0 lands.

- Language: TypeScript (Node 20+ LTS) across a pnpm monorepo
- Auth: Keycloak (OIDC)
- Database: PostgreSQL 16 (PostGIS) — separate from CitrineOS's own database
- Local dev: Docker Compose (Postgres, Keycloak, CitrineOS stack, charger simulator)

## Current status

Phase 0 (repository & infrastructure bootstrap) is in progress.

## Repository layout

Planned layout (see PRD section 4) will appear as workspace packages land:

```
/apps/api              Fastify API service
/apps/dashboard        Next.js operator dashboard
/packages/db           Schema, migrations, RLS policies, seed data
/packages/csms-adapter Only module allowed to talk to CitrineOS
/packages/shared       Shared types, Zod schemas, constants
/tools/simulator       Charger simulator (OCPP 1.6J)
/infra/compose         Docker Compose files and env templates
/docs                  Architecture, decisions (ADRs), runbook
```
