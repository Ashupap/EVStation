/**
 * Our own PostgreSQL database (PostGIS 16 image): schema, migrations,
 * row-level security policies, seed data. Drizzle ORM or Prisma is chosen in
 * Phase 1 (ADR in docs/DECISIONS.md) — see PRD sections 4 and 6.
 *
 * Must remain a separate database from CitrineOS's own.
 */
export const DATABASE_NAME = 'evstation';
