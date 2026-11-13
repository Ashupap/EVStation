import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import type { Capability } from './authorize.js';
import { requireCapability } from './authorize.js';
import type { ApiConfig } from './config.js';
import type { ApiDb } from './db.js';
import { AppError } from './errors.js';
import type { CsmsAdapter } from '@evstation/csms-adapter';
import { setActorContext, setTenantContext } from './context.js';
import { releaseStationLock, tryStationLock } from './station-lock.js';
import { CsmsError } from '@evstation/csms-adapter';
import type { Mailer } from './mailer.js';
import { PaginationQuery, decodeCursor, page } from './pagination.js';
import type { Principal, Role } from './principal.js';
import { dispatchInvitationEmail, queueInvitationEmail } from './outbox.js';

const uuid = z.string().uuid();
const role = z.enum(['tenant_admin', 'site_manager', 'viewer']);

const TenantCreate = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  })
  .strict();
const TenantUpdate = z
  .object({
    status: z.enum(['active', 'suspended']),
  })
  .strict();
const MeUpdate = z
  .object({
    display_name: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();
const SiteCreate = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();
const SiteUpdate = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
const RoleUpdate = z
  .object({
    role,
    site_ids: z
      .array(uuid)
      .max(100)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .strict();
const InvitationCreate = z
  .object({
    email: z.string().trim().email().max(320),
    role,
    site_ids: z
      .array(uuid)
      .max(100)
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();
const InvitationAccept = z.object({ token: z.string().min(20).max(512) }).strict();
const IdParams = z.object({ id: uuid }).strict();

function maskIdTag(value: string | null): string | null {
  return value ? `****${value.slice(-4)}` : null;
}
const InvitationParams = z.object({ tenantId: uuid, invitationId: uuid }).strict();
const TenantParams = z.object({ tenantId: uuid }).strict();
const StationCreate = z
  .object({
    site_id: uuid,
    station_ref: z.string().trim().min(8).max(20),
    vendor: z.string().trim().max(200).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
    serial: z.string().trim().max(200).nullable().optional(),
    firmware_version: z.string().trim().max(200).nullable().optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
    connectors: z
      .array(
        z
          .object({
            connector_number: z.number().int().positive(),
            type: z.string().trim().max(100).nullable().optional(),
            max_power_w: z.number().int().positive().nullable().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
const EventQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(1000).default(200) })
  .strict();
const SessionQuery = PaginationQuery.extend({
  station_id: uuid.optional(),
  status: z.enum(['starting', 'active', 'completed', 'failed']).optional(),
}).strict();
const StationUpdate = z
  .object({
    vendor: z.string().trim().max(200).nullable().optional(),
    model: z.string().trim().max(200).nullable().optional(),
    serial: z.string().trim().max(200).nullable().optional(),
    firmware_version: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');

interface RouteContext {
  request: FastifyRequest;
  reply: FastifyReply;
  client: PoolClient;
  db: ApiDb;
  principal: Principal;
  tenantId: string | undefined;
  config: ApiConfig;
  mailer: Mailer;
  adapter: CsmsAdapter;
  afterCommit: (task: () => Promise<void>) => void;
}

type TenantSource = 'none' | 'header' | { param: string };

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  tenantSource: TenantSource;
  capability: Capability;
  auditAction?: string;
  handler: (ctx: RouteContext) => Promise<unknown>;
  schema?: Record<string, unknown>;
  isolation?: { body?: Record<string, unknown>; params?: Record<string, string> };
  config?: Record<string, unknown>;
}

export const ROUTES: RouteDefinition[] = [
  {
    method: 'GET',
    url: '/me',
    tenantSource: 'none',
    capability: 'me.read',
    schema: { tags: ['me'] },
    async handler({ principal }) {
      return {
        id: principal.id,
        email: principal.email,
        display_name: principal.displayName,
        email_verified: principal.emailVerified,
        is_platform_admin: principal.isPlatformAdmin,
        memberships: principal.memberships.map((membership) => ({
          tenant_id: membership.tenantId,
          tenant_name: membership.tenantName,
          tenant_slug: membership.tenantSlug,
          role: membership.role,
          site_ids: membership.siteIds,
        })),
      };
    },
  },
  {
    method: 'PATCH',
    url: '/me',
    tenantSource: 'none',
    capability: 'me.update',
    auditAction: 'user.profile_updated',
    schema: { tags: ['me'], body: MeUpdate },
    async handler({ client, principal, request }) {
      const body = MeUpdate.parse(request.body);
      const { rows } = await client.query<{ id: string; display_name: string | null }>(
        'UPDATE app.users SET display_name = $2 WHERE id = $1 RETURNING id, display_name',
        [principal.id, body.display_name],
      );
      if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'user not found');
      await writeAudit(client, principal, {
        tenantId: null,
        action: 'user.profile_updated',
        resourceType: 'user',
        resourceId: principal.id,
        requestId: request.id,
      });
      return { id: rows[0].id, display_name: rows[0].display_name };
    },
  },
  {
    method: 'GET',
    url: '/tenants',
    tenantSource: 'none',
    capability: 'tenant.read',
    schema: { tags: ['tenants'], querystring: PaginationQuery },
    async handler({ client, request }) {
      const query = PaginationQuery.parse(request.query);
      const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
      const { rows } = await client.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, name, slug, status, created_at, updated_at
         FROM app.tenants
         ${after ? 'WHERE (name, id) > ($1, $2)' : ''}
         ORDER BY name, id LIMIT $${after ? 3 : 1}`,
        after ? [...after, query.limit + 1] : [query.limit + 1],
      );
      const result = page(rows, query.limit, (row) => [row.name, row.id]);
      return { tenants: result.items, next_cursor: result.nextCursor };
    },
  },
  {
    method: 'POST',
    url: '/tenants',
    tenantSource: 'none',
    capability: 'tenant.create',
    auditAction: 'tenant.created',
    schema: { tags: ['tenants'], body: TenantCreate },
    async handler({ client, principal, request, reply }) {
      const body = TenantCreate.parse(request.body);
      const { rows } = await client.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
      }>(
        `INSERT INTO app.tenants (name, slug) VALUES ($1, $2)
         RETURNING id, name, slug, status, created_at, updated_at`,
        [body.name, body.slug],
      );
      const tenant = rows[0];
      if (!tenant) throw new AppError(500, 'INTERNAL', 'tenant insert returned no row');
      await writeAudit(client, principal, {
        tenantId: tenant.id,
        action: 'tenant.created',
        resourceType: 'tenant',
        resourceId: tenant.id,
        requestId: request.id,
      });
      void reply.code(201);
      return tenant;
    },
  },
  {
    method: 'PATCH',
    url: '/tenants/:id',
    tenantSource: 'none',
    capability: 'tenant.update',
    auditAction: 'tenant.status_changed',
    schema: { tags: ['tenants'], params: IdParams, body: TenantUpdate },
    async handler({ client, principal, request }) {
      const params = IdParams.parse(request.params);
      const body = TenantUpdate.parse(request.body);
      const { rows } = await client.query<{
        id: string;
        status: string;
        name: string;
        slug: string;
      }>(
        `UPDATE app.tenants SET status = $2 WHERE id = $1
         RETURNING id, name, slug, status, created_at, updated_at`,
        [params.id, body.status],
      );
      const tenant = rows[0];
      if (!tenant) throw new AppError(404, 'NOT_FOUND', 'tenant not found');
      await writeAudit(client, principal, {
        tenantId: tenant.id,
        action: 'tenant.status_changed',
        resourceType: 'tenant',
        resourceId: tenant.id,
        requestId: request.id,
        details: { status: body.status },
      });
      return tenant;
    },
  },
  {
    method: 'GET',
    url: '/sites',
    tenantSource: 'header',
    capability: 'site.read',
    schema: { tags: ['sites'], querystring: PaginationQuery },
    async handler({ client, request }) {
      const query = PaginationQuery.parse(request.query);
      const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        name: string;
        address: string | null;
        status: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, tenant_id, name, address, status, created_at, updated_at
         FROM app.sites
         ${after ? 'WHERE (name, id) > ($1, $2)' : ''}
         ORDER BY name, id LIMIT $${after ? 3 : 1}`,
        after ? [...after, query.limit + 1] : [query.limit + 1],
      );
      const result = page(rows, query.limit, (row) => [row.name, row.id]);
      return { sites: result.items, next_cursor: result.nextCursor };
    },
  },
  {
    method: 'POST',
    url: '/sites',
    tenantSource: 'header',
    capability: 'site.create',
    auditAction: 'site.created',
    schema: { tags: ['sites'], body: SiteCreate },
    isolation: { body: { name: 'probe' } },
    async handler({ client, principal, tenantId, request, reply }) {
      const body = SiteCreate.parse(request.body);
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        name: string;
        address: string | null;
        status: string;
      }>(
        `INSERT INTO app.sites (tenant_id, name, address, status)
         VALUES ($1, $2, $3, coalesce($4, 'active'))
         RETURNING id, tenant_id, name, address, status, created_at, updated_at`,
        [tenantId, body.name, body.address ?? null, body.status ?? null],
      );
      const site = rows[0];
      if (!site || !tenantId) throw new AppError(500, 'INTERNAL', 'site insert returned no row');
      await writeAudit(client, principal, {
        tenantId,
        action: 'site.created',
        resourceType: 'site',
        resourceId: site.id,
        requestId: request.id,
      });
      void reply.code(201);
      return site;
    },
  },
  {
    method: 'PATCH',
    url: '/sites/:id',
    tenantSource: 'header',
    capability: 'site.update',
    auditAction: 'site.updated',
    schema: { tags: ['sites'], params: IdParams, body: SiteUpdate },
    isolation: { body: { name: 'probe' }, params: { id: '20000000-0000-4000-8000-000000000003' } },
    async handler({ client, principal, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const body = SiteUpdate.parse(request.body);
      const existing = await client.query<{
        id: string;
        tenant_id: string;
        name: string;
        address: string | null;
        status: string;
      }>(
        `SELECT id, tenant_id, name, address, status
         FROM app.sites WHERE id = $1`,
        [params.id],
      );
      const site = existing.rows[0];
      if (!site) throw new AppError(404, 'NOT_FOUND', 'site not found');
      requireCapability(principal, tenantId, 'site.update', { siteId: site.id });

      const sets: string[] = [];
      const values: unknown[] = [site.id];
      for (const [column, value] of [
        ['name', body.name],
        ['address', body.address],
        ['status', body.status],
      ] as const) {
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        name: string;
        address: string | null;
        status: string;
      }>(
        `UPDATE app.sites SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, tenant_id, name, address, status, created_at, updated_at`,
        values,
      );
      if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'site not found');
      await writeAudit(client, principal, {
        tenantId: site.tenant_id,
        action: 'site.updated',
        resourceType: 'site',
        resourceId: site.id,
        requestId: request.id,
      });
      return rows[0];
    },
  },
  {
    method: 'GET',
    url: '/users',
    tenantSource: 'header',
    capability: 'user.read',
    schema: { tags: ['users'], querystring: PaginationQuery },
    async handler({ client, request, tenantId }) {
      const query = PaginationQuery.parse(request.query);
      const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
      const { rows } = await client.query<{
        id: string;
        email: string;
        display_name: string | null;
        membership_id: string;
        role: Role;
        site_ids: string[];
      }>(
        `SELECT u.id, u.email, u.display_name, m.id AS membership_id, m.role,
                coalesce(array_agg(ms.site_id) FILTER (WHERE ms.site_id IS NOT NULL), '{}')
                  AS site_ids
         FROM app.memberships m
         JOIN app.users u ON u.id = m.user_id
         LEFT JOIN app.membership_sites ms ON ms.membership_id = m.id
         WHERE m.tenant_id = $1
           ${after ? 'AND (u.email, u.id) > ($2, $3)' : ''}
         GROUP BY u.id, u.email, u.display_name, m.id, m.role
         ORDER BY u.email, u.id
         LIMIT $${after ? 4 : 2}`,
        after ? [tenantId, ...after, query.limit + 1] : [tenantId, query.limit + 1],
      );
      const result = page(rows, query.limit, (row) => [row.email, row.id]);
      return { users: result.items, next_cursor: result.nextCursor };
    },
  },
  {
    method: 'PATCH',
    url: '/users/:id/role',
    tenantSource: 'header',
    capability: 'user.role.update',
    auditAction: 'user.role_changed',
    schema: { tags: ['users'], params: IdParams, body: RoleUpdate },
    isolation: {
      body: { role: 'viewer' },
      params: { id: '00000000-0000-4000-8000-000000000003' },
    },
    async handler({ client, principal, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const body = RoleUpdate.parse(request.body);
      const siteIds = body.site_ids ?? [];
      if (body.role === 'site_manager' && siteIds.length === 0) {
        throw new AppError(400, 'SITE_REQUIRED', 'site_manager requires at least one site');
      }
      if (body.role !== 'site_manager' && siteIds.length > 0) {
        throw new AppError(400, 'SITE_SCOPE_NOT_ALLOWED', 'site_ids only apply to site_manager');
      }
      const current = await client.query<{ id: string; role: Role }>(
        'SELECT id, role FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, params.id],
      );
      const previous = current.rows[0];
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'membership not found');
      const { rows } = await client.query<{ id: string; user_id: string; role: Role }>(
        `UPDATE app.memberships SET role = $3
         WHERE tenant_id = $1 AND user_id = $2
         RETURNING id, user_id, role`,
        [tenantId, params.id, body.role],
      );
      if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'membership not found');

      await client.query('DELETE FROM app.membership_sites WHERE membership_id = $1', [
        previous.id,
      ]);
      if (body.role === 'site_manager') {
        const inserted = await client.query(
          `INSERT INTO app.membership_sites (membership_id, site_id, tenant_id)
           SELECT $1, s.id, $2 FROM app.sites s
           WHERE s.tenant_id = $2 AND s.id = ANY($3::uuid[])
           RETURNING 1`,
          [previous.id, tenantId, siteIds],
        );
        if (inserted.rowCount !== siteIds.length) {
          throw new AppError(400, 'INVALID_SITE_SCOPE', 'site_ids must belong to the tenant');
        }
      }

      await writeAudit(client, principal, {
        tenantId: tenantId ?? null,
        action: 'user.role_changed',
        resourceType: 'user',
        resourceId: params.id,
        requestId: request.id,
        details: {
          from: previous.role,
          to: body.role,
          ...(body.role === 'site_manager' ? { site_ids: siteIds } : {}),
        },
      });
      return rows[0];
    },
  },
  {
    method: 'GET',
    url: '/tenants/:tenantId/invitations',
    tenantSource: { param: 'tenantId' },
    capability: 'invitation.read',
    schema: { tags: ['invitations'], params: TenantParams },
    async handler({ client, tenantId }) {
      const { rows } = await client.query(
        `SELECT id, tenant_id, email, role, site_ids, invited_by, expires_at,
                accepted_at, accepted_by, revoked_at, created_at
         FROM app.invitations
         WHERE tenant_id = $1 ORDER BY created_at DESC, id`,
        [tenantId],
      );
      return { invitations: rows };
    },
  },
  {
    method: 'POST',
    url: '/tenants/:tenantId/invitations',
    tenantSource: { param: 'tenantId' },
    capability: 'invitation.create',
    auditAction: 'invitation.created',
    schema: { tags: ['invitations'], params: TenantParams, body: InvitationCreate },
    isolation: {
      body: { email: 'probe@example.com', role: 'viewer', site_ids: [] },
    },
    async handler({
      client,
      db,
      principal,
      tenantId,
      request,
      reply,
      config,
      mailer,
      afterCommit,
    }) {
      const body = InvitationCreate.parse(request.body);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
        role: Role;
        site_ids: string[];
        expires_at: Date;
      }>(
        `INSERT INTO app.invitations
           (tenant_id, email, role, site_ids, invited_by, token_hash, expires_at)
         VALUES ($1, lower($2), $3, $4, $5, $6, now() + interval '7 days')
         RETURNING id, tenant_id, email, role, site_ids, expires_at`,
        [tenantId, body.email, body.role, body.site_ids, principal.id, tokenHash],
      );
      const invitation = rows[0];
      if (!invitation) throw new AppError(500, 'INTERNAL', 'invitation insert returned no row');
      const acceptUrl = `${config.invitationAcceptBaseUrl}#token=${encodeURIComponent(token)}`;
      const outboxId = await queueInvitationEmail(client, {
        invitationId: invitation.id,
        tenantId: invitation.tenant_id,
        recipient: invitation.email,
        acceptUrl,
        expiresAt: invitation.expires_at,
      });
      afterCommit(async () => {
        await dispatchInvitationEmail({
          db,
          outboxId,
          mailer,
          onFailure: () => request.log.error({ outboxId }, 'invitation email dispatch failed'),
        });
      });
      await writeAudit(client, principal, {
        tenantId: tenantId ?? null,
        action: 'invitation.created',
        resourceType: 'invitation',
        resourceId: invitation.id,
        requestId: request.id,
        details: { email: body.email, role: body.role },
      });
      void reply.code(201);
      return {
        ...invitation,
        ...(config.nodeEnv === 'production' ? {} : { accept_url: acceptUrl }),
      };
    },
  },
  {
    method: 'DELETE',
    url: '/tenants/:tenantId/invitations/:invitationId',
    tenantSource: { param: 'tenantId' },
    capability: 'invitation.revoke',
    auditAction: 'invitation.revoked',
    schema: { tags: ['invitations'], params: InvitationParams },
    isolation: {
      params: { invitationId: '00000000-0000-0000-0000-000000000000' },
    },
    async handler({ client, principal, tenantId, request, reply }) {
      const params = InvitationParams.parse(request.params);
      const { rows } = await client.query<{ id: string }>(
        `UPDATE app.invitations SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
        [params.invitationId, tenantId],
      );
      const invitation = rows[0];
      if (!invitation) throw new AppError(404, 'NOT_FOUND', 'invitation not found');
      await writeAudit(client, principal, {
        tenantId: tenantId ?? null,
        action: 'invitation.revoked',
        resourceType: 'invitation',
        resourceId: invitation.id,
        requestId: request.id,
      });
      void reply.code(204);
      return undefined;
    },
  },
  {
    method: 'GET',
    url: '/ingestion-rejections',
    tenantSource: 'none',
    capability: 'ingestion.read',
    schema: { tags: ['ingestion'], querystring: EventQuery },
    async handler({ client, request }) {
      const query = EventQuery.parse(request.query);
      const { rows } = await client.query(
        `SELECT station_ref, reason_code, day, occurrence_count, first_seen_at, last_seen_at
         FROM app.ingestion_rejections
         ORDER BY day DESC, station_ref, reason_code LIMIT $1`,
        [query.limit],
      );
      return { ingestion_rejections: rows };
    },
  },
  {
    method: 'GET',
    url: '/sessions',
    tenantSource: 'header',
    capability: 'session.read',
    schema: { tags: ['sessions'], querystring: SessionQuery },
    async handler({ client, tenantId, request }) {
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const query = SessionQuery.parse(request.query);
      const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
      const values: unknown[] = [tenantId];
      const filters = ['s.tenant_id = $1'];
      if (query.station_id) {
        values.push(query.station_id);
        filters.push(`s.station_id = $${values.length}`);
      }
      if (query.status) {
        values.push(query.status);
        filters.push(`s.status = $${values.length}`);
      }
      if (after) {
        values.push(after[0], after[1]);
        filters.push(
          `(s.started_at, s.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(query.limit + 1);
      const { rows } = await client.query(
        `SELECT s.id, s.tenant_id, s.site_id, s.station_id, s.connector_id,
                s.csms_transaction_ref, s.id_tag, s.started_at, s.ended_at,
                s.energy_wh, s.status, s.stop_reason, s.started_at_source,
                s.ended_at_source, s.created_at, s.updated_at,
                st.station_ref, c.connector_number
         FROM app.sessions s
         JOIN app.stations st ON st.id = s.station_id
         JOIN app.connectors c ON c.id = s.connector_id
         WHERE ${filters.join(' AND ')}
         ORDER BY s.started_at DESC, s.id DESC LIMIT $${values.length}`,
        values,
      );
      const masked = rows.map((row) => ({
        ...row,
        id_tag: maskIdTag((row as { id_tag: string | null }).id_tag),
      }));
      const pageResult = page(masked, query.limit, (row) => {
        const startedAt = (row as { started_at: Date | string }).started_at;
        return [
          startedAt instanceof Date ? startedAt.toISOString() : String(startedAt),
          String((row as { id: string }).id),
        ];
      });
      return { sessions: pageResult.items, next_cursor: pageResult.nextCursor };
    },
  },
  {
    method: 'GET',
    url: '/sessions/:id',
    tenantSource: 'header',
    capability: 'session.read',
    schema: { tags: ['sessions'], params: IdParams },
    isolation: { params: { id: '50000000-0000-4000-8000-000000000001' } },
    async handler({ client, tenantId, request }) {
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const params = IdParams.parse(request.params);
      const session = await client.query(
        `SELECT s.*, st.station_ref, c.connector_number
         FROM app.sessions s
         JOIN app.stations st ON st.id = s.station_id
         JOIN app.connectors c ON c.id = s.connector_id
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [params.id, tenantId],
      );
      const sessionRow = session.rows[0] as
        (Record<string, unknown> & { id_tag?: string | null }) | undefined;
      if (!sessionRow) throw new AppError(404, 'NOT_FOUND', 'session not found');
      sessionRow.id_tag = maskIdTag(sessionRow.id_tag ?? null);
      const meters = await client.query(
        `SELECT id, csms_event_ref, csms_timestamp, charger_reported_at, energy_wh, power_w
         FROM app.session_meter_values
         WHERE session_id = $1 AND tenant_id = $2
         ORDER BY csms_timestamp, id LIMIT 200`,
        [params.id, tenantId],
      );
      return { session: sessionRow, meter_values: meters.rows };
    },
  },
  {
    method: 'GET',
    url: '/stations',
    tenantSource: 'header',
    capability: 'station.read',
    schema: { tags: ['stations'], querystring: PaginationQuery },
    async handler({ client, tenantId, request }) {
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const query = PaginationQuery.parse(request.query);
      const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
      const { rows } = await client.query(
        `SELECT s.id, s.tenant_id, s.site_id, s.station_ref, s.registration_status,
                s.credentials_state, s.vendor, s.model, s.serial, s.firmware_version,
                s.ocpp_version, s.created_at, s.updated_at,
                r.connection_state, r.last_heartbeat_at, r.last_connected_at, r.last_seen_at
         FROM app.stations s
         LEFT JOIN app.station_runtime_state r ON r.station_id = s.id
         WHERE s.tenant_id = $1 ${after ? 'AND (s.station_ref, s.id) > ($2, $3)' : ''}
         ORDER BY s.station_ref, s.id LIMIT $${after ? 4 : 2}`,
        after ? [tenantId, ...after, query.limit + 1] : [tenantId, query.limit + 1],
      );
      const pageResult = page(rows, query.limit, (row) => [row.station_ref, row.id]);
      return { stations: pageResult.items, next_cursor: pageResult.nextCursor };
    },
  },
  {
    method: 'POST',
    url: '/stations',
    tenantSource: 'header',
    capability: 'station.create',
    auditAction: 'station.created',
    schema: { tags: ['stations'], body: StationCreate },
    isolation: {
      body: { site_id: '20000000-0000-4000-8000-000000000001', station_ref: 'ACME-BLR-900' },
    },
    async handler({ client, db, principal, tenantId, request, reply, adapter }) {
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const body = StationCreate.parse(request.body);
      const site = await client.query<{
        site_code: string;
        org_code: string;
        csms_location_id: number | null;
      }>(
        `SELECT s.site_code, t.org_code, s.csms_location_id
         FROM app.sites s JOIN app.tenants t ON t.id = s.tenant_id
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [body.site_id, tenantId],
      );
      const location = site.rows[0];
      if (!location?.site_code || !location.org_code) {
        throw new AppError(409, 'SITE_CODE_REQUIRED', 'site_code and org_code are required');
      }
      if (!location.csms_location_id && body.latitude === undefined) {
        throw new AppError(400, 'LOCATION_REQUIRED', 'coordinates or a CSMS location are required');
      }
      const registrationLock = await db.pool.connect();
      try {
        if (!(await tryStationLock(registrationLock, body.station_ref))) {
          void reply.code(409);
          return {
            error: {
              code: 'REGISTRATION_IN_PROGRESS',
              message: 'station registration is already in progress',
            },
          };
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO app.stations (tenant_id, site_id, org_code, station_ref, vendor, model, serial,
           firmware_version, ocpp_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ocpp1.6') RETURNING id`,
          [
            tenantId,
            body.site_id,
            location.org_code,
            body.station_ref,
            body.vendor ?? null,
            body.model ?? null,
            body.serial ?? null,
            body.firmware_version ?? null,
          ],
        );
        const stationId = inserted.rows[0]!.id;
        await client.query('COMMIT');
        const registrationInput = {
          stationId,
          tenantId,
          siteId: body.site_id,
          stationRef: body.station_ref,
          orgCode: location.org_code,
          siteCode: location.site_code,
          csmsLocationId: location.csms_location_id,
          latitude: body.latitude,
          longitude: body.longitude,
          vendor: body.vendor,
          model: body.model,
          serial: body.serial,
          firmwareVersion: body.firmware_version,
          ocppVersion: 'ocpp1.6' as const,
          connectors: body.connectors?.map((item) => ({
            connectorNumber: item.connector_number,
            type: item.type,
            maxPowerW: item.max_power_w,
          })),
        };

        let result;
        try {
          result = await adapter.registerStation(registrationInput);
        } catch (error) {
          const code = error instanceof CsmsError ? error.code : 'CSMS_REGISTRATION_FAILED';
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            await tx.query('SELECT app.mark_station_registration_failed($1, $2)', [
              stationId,
              code,
            ]);
            await writeAudit(tx, principal, {
              tenantId,
              action: 'station.registration_failed',
              resourceType: 'station',
              resourceId: stationId,
              requestId: request.id,
              details: { code },
            });
          });
          void reply.code(code === 'CSMS_CONFLICT' ? 409 : 502);
          return {
            error: { code, message: 'station registration failed' },
            station: {
              id: stationId,
              station_ref: body.station_ref,
              registration_status: 'registration_failed',
            },
          };
        }

        try {
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            if (result.csmsLocationId) {
              await tx.query('SELECT app.set_site_csms_location($1, $2)', [
                body.site_id,
                result.csmsLocationId,
              ]);
            }
            await tx.query('SELECT app.mark_station_registered($1, $2)', [
              stationId,
              result.csmsStationId,
            ]);
            const connectors = body.connectors?.length
              ? body.connectors
              : [{ connector_number: 1 }];
            for (const connector of connectors) {
              await tx.query(
                `INSERT INTO app.connectors
                 (tenant_id, site_id, station_id, connector_number, type, max_power_w)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (station_id, connector_number) DO NOTHING`,
                [
                  tenantId,
                  body.site_id,
                  stationId,
                  connector.connector_number,
                  connector.type ?? null,
                  connector.max_power_w ?? null,
                ],
              );
            }
            await writeAudit(tx, principal, {
              tenantId,
              action: 'station.created',
              resourceType: 'station',
              resourceId: stationId,
              requestId: request.id,
            });
          });
        } catch {
          void reply.code(503);
          return {
            error: {
              code: 'REGISTRATION_STATE_RETRY',
              message: 'registration succeeded but state could not be recorded; retry',
              retryable: true,
            },
            station: {
              id: stationId,
              station_ref: body.station_ref,
              registration_status: 'pending',
            },
          };
        }

        try {
          const credentials = await adapter.provisionPassword(body.station_ref);
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            await tx.query('SELECT app.mark_station_credentials_provisioned($1)', [stationId]);
          });
          void reply.code(201);
          void reply.header('cache-control', 'no-store');
          return {
            station: {
              id: stationId,
              station_ref: body.station_ref,
              registration_status: 'registered',
            },
            credentials: { username: body.station_ref, password: credentials },
          };
        } catch (error) {
          const code = error instanceof CsmsError ? error.code : 'CSMS_CREDENTIAL_FAILED';
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            await tx.query('SELECT app.mark_station_rotation_incomplete($1)', [stationId]);
            await writeAudit(tx, principal, {
              tenantId,
              action: 'station.credentials_rotation_failed',
              resourceType: 'station',
              resourceId: stationId,
              requestId: request.id,
              details: { code },
            });
          });
          void reply.code(502);
          return {
            error: {
              code,
              message: 'station registered but credential provisioning is incomplete',
            },
            station: {
              id: stationId,
              station_ref: body.station_ref,
              registration_status: 'registered',
              credentials_state: 'rotation_incomplete',
            },
          };
        }
      } finally {
        await releaseStationLock(registrationLock, body.station_ref);
      }
    },
  },
  {
    method: 'GET',
    url: '/stations/:id',
    tenantSource: 'header',
    capability: 'station.read',
    schema: { tags: ['stations'], params: IdParams },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    async handler({ client, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const { rows } = await client.query(
        `SELECT s.*, r.connection_state, r.last_heartbeat_at, r.last_connected_at, r.last_seen_at
         FROM app.stations s LEFT JOIN app.station_runtime_state r ON r.station_id = s.id
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [params.id, tenantId],
      );
      if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'station not found');
      return rows[0];
    },
  },
  {
    method: 'PATCH',
    url: '/stations/:id',
    tenantSource: 'header',
    capability: 'station.update',
    auditAction: 'station.updated',
    schema: { tags: ['stations'], params: IdParams, body: StationUpdate },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' }, body: { vendor: 'x' } },
    async handler({ client, principal, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const body = StationUpdate.parse(request.body);
      const { rows } = await client.query(
        `UPDATE app.stations SET vendor = coalesce($3, vendor), model = coalesce($4, model),
           serial = coalesce($5, serial), firmware_version = coalesce($6, firmware_version)
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, station_ref, vendor, model, serial, firmware_version`,
        [params.id, tenantId, body.vendor, body.model, body.serial, body.firmware_version],
      );
      if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'station not found');
      await writeAudit(client, principal, {
        tenantId: tenantId ?? null,
        action: 'station.updated',
        resourceType: 'station',
        resourceId: params.id,
        requestId: request.id,
      });
      return rows[0];
    },
  },
  {
    method: 'GET',
    url: '/stations/:id/status-events',
    tenantSource: 'header',
    capability: 'station.read',
    schema: { tags: ['stations'], params: IdParams, querystring: EventQuery },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    async handler({ client, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const query = EventQuery.parse(request.query);
      const station = await client.query(
        'SELECT id FROM app.stations WHERE id = $1 AND tenant_id = $2',
        [params.id, tenantId],
      );
      if (!station.rows[0]) throw new AppError(404, 'NOT_FOUND', 'station not found');
      const { rows } = await client.query(
        `SELECT e.id, e.connector_id, c.connector_number, e.status, e.error_code,
                e.csms_event_ref, e.csms_timestamp, e.charger_reported_at
         FROM app.station_status_events e
         LEFT JOIN app.connectors c ON c.id = e.connector_id
         WHERE e.station_id = $1 AND e.tenant_id = $2
         ORDER BY e.csms_timestamp DESC, e.id DESC LIMIT $3`,
        [params.id, tenantId, query.limit],
      );
      return { status_events: rows };
    },
  },
  {
    method: 'GET',
    url: '/stations/:id/ingestion-events',
    tenantSource: 'header',
    capability: 'station.read',
    schema: { tags: ['stations'], params: IdParams, querystring: EventQuery },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    async handler({ client, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const query = EventQuery.parse(request.query);
      const station = await client.query<{ station_ref: string }>(
        'SELECT station_ref FROM app.stations WHERE id = $1 AND tenant_id = $2',
        [params.id, tenantId],
      );
      const row = station.rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', 'station not found');
      const { rows } = await client.query(
        `SELECT id, station_ref, kind, csms_event_ref, csms_timestamp, outcome,
                reason_code, occurrence_count
         FROM app.ingestion_events
         WHERE station_ref = $1 AND tenant_id = $2
         ORDER BY csms_timestamp DESC, id DESC LIMIT $3`,
        [row.station_ref, tenantId, query.limit],
      );
      return { ingestion_events: rows };
    },
  },
  {
    method: 'GET',
    url: '/stations/:id/connectors',
    tenantSource: 'header',
    capability: 'station.read',
    schema: { tags: ['stations'], params: IdParams },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    async handler({ client, tenantId, request }) {
      const params = IdParams.parse(request.params);
      const station = await client.query(
        'SELECT id FROM app.stations WHERE id = $1 AND tenant_id = $2',
        [params.id, tenantId],
      );
      if (!station.rows[0]) throw new AppError(404, 'NOT_FOUND', 'station not found');
      const { rows } = await client.query(
        `SELECT id, connector_number, type, max_power_w, status, error_code, last_status_at
         FROM app.connectors WHERE station_id = $1 AND tenant_id = $2 ORDER BY connector_number`,
        [params.id, tenantId],
      );
      return { connectors: rows };
    },
  },
  {
    method: 'POST',
    url: '/stations/:id/credentials/rotate',
    tenantSource: 'header',
    capability: 'station.credentials.rotate',
    auditAction: 'station.credentials_rotated',
    schema: { tags: ['stations'], params: IdParams },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 3_600_000,
        keyGenerator: (request: FastifyRequest) =>
          `${request.claims?.sub ?? 'anonymous'}:${(request.params as { id?: string }).id ?? 'none'}`,
      },
    },
    async handler({ client, db, principal, tenantId, request, reply, adapter }) {
      const params = IdParams.parse(request.params);
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const station = await client.query<{
        station_ref: string;
        registration_status: string;
        credentials_state: string;
      }>(
        'SELECT station_ref, registration_status, credentials_state FROM app.stations WHERE id = $1 AND tenant_id = $2',
        [params.id, tenantId],
      );
      const row = station.rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', 'station not found');
      if (
        row.registration_status !== 'registered' ||
        !['provisioned', 'rotation_incomplete'].includes(row.credentials_state)
      ) {
        throw new AppError(
          409,
          'STATION_NOT_ROTATABLE',
          'station is not ready for credential rotation',
        );
      }
      await client.query('COMMIT');
      const lock = await db.pool.connect();
      try {
        if (!(await tryStationLock(lock, row.station_ref))) {
          void reply.code(409);
          return {
            error: {
              code: 'ROTATION_IN_PROGRESS',
              message: 'credential rotation is already in progress',
            },
          };
        }
        let credentials: string;
        try {
          credentials = await adapter.rotatePassword(row.station_ref);
        } catch (error) {
          const code = error instanceof CsmsError ? error.code : 'CSMS_ROTATION_FAILED';
          try {
            await db.transaction(async (tx) => {
              await setActorContext(tx, principal.id);
              await setTenantContext(tx, tenantId);
              await tx.query('SELECT app.mark_station_rotation_incomplete($1)', [params.id]);
              await writeAudit(tx, principal, {
                tenantId,
                action: 'station.credentials_rotation_failed',
                resourceType: 'station',
                resourceId: params.id,
                requestId: request.id,
                details: { code },
              });
            });
          } catch {
            // Preserve the adapter failure as the response.
          }
          void reply.code(502);
          return {
            error: { code, message: 'credential rotation incomplete' },
            station_id: params.id,
            credentials_state: 'rotation_incomplete',
          };
        }
        try {
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            await tx.query('SELECT app.mark_station_credentials_provisioned($1)', [params.id]);
            await writeAudit(tx, principal, {
              tenantId,
              action: 'station.credentials_rotated',
              resourceType: 'station',
              resourceId: params.id,
              requestId: request.id,
            });
          });
        } catch {
          void reply.code(500);
          return {
            error: {
              code: 'CREDENTIALS_STATE_FAILED',
              message: 'rotation state could not be recorded',
            },
          };
        }
        void reply.header('cache-control', 'no-store');
        return {
          station_id: params.id,
          credentials: { username: row.station_ref, password: credentials },
        };
      } finally {
        await releaseStationLock(lock, row.station_ref);
      }
    },
  },
  {
    method: 'POST',
    url: '/stations/:id/register/retry',
    tenantSource: 'header',
    capability: 'station.credentials.rotate',
    auditAction: 'station.registration_retried',
    schema: { tags: ['stations'], params: IdParams },
    isolation: { params: { id: '30000000-0000-4000-8000-000000000001' } },
    async handler({ client, db, principal, tenantId, request, reply, adapter }) {
      const params = IdParams.parse(request.params);
      if (!tenantId) throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
      const station = await client.query<{
        station_ref: string;
        registration_status: string;
        site_id: string;
        org_code: string;
        site_code: string;
        csms_location_id: number | null;
        credentials_state: string;
      }>(
        `SELECT s.station_ref, s.registration_status, s.site_id, s.org_code, site.site_code,
                site.csms_location_id, s.credentials_state
         FROM app.stations s JOIN app.sites site ON site.id = s.site_id
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [params.id, tenantId],
      );
      const row = station.rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', 'station not found');
      const retryable =
        row.registration_status === 'pending' ||
        row.registration_status === 'registration_failed' ||
        (row.registration_status === 'registered' &&
          ['none', 'rotation_incomplete'].includes(row.credentials_state));
      if (!retryable) {
        throw new AppError(409, 'STATION_NOT_RETRYABLE', 'station is not in a retryable state');
      }
      await client.query('COMMIT');
      const registrationLock = await db.pool.connect();
      try {
        if (!(await tryStationLock(registrationLock, row.station_ref))) {
          void reply.code(409);
          return {
            error: {
              code: 'REGISTRATION_IN_PROGRESS',
              message: 'station registration is already in progress',
            },
          };
        }
        const result = await adapter.registerStation({
          stationId: params.id,
          tenantId,
          siteId: row.site_id,
          stationRef: row.station_ref,
          orgCode: row.org_code,
          siteCode: row.site_code,
          csmsLocationId: row.csms_location_id,
          ocppVersion: 'ocpp1.6',
        });
        await db.transaction(async (tx) => {
          await setActorContext(tx, principal.id);
          await setTenantContext(tx, tenantId);
          if (result.csmsLocationId) {
            await tx.query('SELECT app.set_site_csms_location($1, $2)', [
              row.site_id,
              result.csmsLocationId,
            ]);
          }
          await tx.query('SELECT app.mark_station_registered($1, $2)', [
            params.id,
            result.csmsStationId,
          ]);
          await writeAudit(tx, principal, {
            tenantId,
            action: 'station.registration_retried',
            resourceType: 'station',
            resourceId: params.id,
            requestId: request.id,
          });
        });
        if (row.credentials_state !== 'provisioned') {
          const credentials = await adapter.provisionPassword(row.station_ref);
          await db.transaction(async (tx) => {
            await setActorContext(tx, principal.id);
            await setTenantContext(tx, tenantId);
            await tx.query('SELECT app.mark_station_credentials_provisioned($1)', [params.id]);
          });
          void reply.header('cache-control', 'no-store');
          return {
            station: {
              id: params.id,
              station_ref: row.station_ref,
              registration_status: 'registered',
            },
            credentials: { username: row.station_ref, password: credentials },
          };
        }
        return {
          station: {
            id: params.id,
            station_ref: row.station_ref,
            registration_status: 'registered',
          },
        };
      } catch (error) {
        const code = error instanceof CsmsError ? error.code : 'CSMS_REGISTRATION_FAILED';
        await db.transaction(async (tx) => {
          await setActorContext(tx, principal.id);
          await setTenantContext(tx, tenantId);
          if (row.registration_status !== 'registered') {
            await tx.query('SELECT app.mark_station_registration_failed($1, $2)', [
              params.id,
              code,
            ]);
          } else {
            await tx.query('SELECT app.mark_station_rotation_incomplete($1)', [params.id]);
          }
        });
        void reply.code(code === 'CSMS_CONFLICT' ? 409 : 502);
        return { error: { code, message: 'station registration retry failed' } };
      } finally {
        await releaseStationLock(registrationLock, row.station_ref);
      }
    },
  },
  {
    method: 'POST',
    url: '/invitations/accept',
    tenantSource: 'none',
    capability: 'invitation.accept',
    schema: { tags: ['invitations'], body: InvitationAccept },
    isolation: { body: { token: 'x'.repeat(43) } },
    async handler({ client, principal, request }) {
      const body = InvitationAccept.parse(request.body);
      const tokenHash = createHash('sha256').update(body.token).digest('hex');
      const { rows } = await client.query<{
        tenant_id: string;
        membership_id: string;
        role: Role;
      }>(`SELECT * FROM app.accept_invitation($1, $2, $3, $4)`, [
        tokenHash,
        principal.id,
        principal.email,
        principal.emailVerified,
      ]);
      const accepted = rows[0];
      if (!accepted) throw new AppError(500, 'INTERNAL', 'invitation acceptance returned no row');
      return {
        tenant_id: accepted.tenant_id,
        membership_id: accepted.membership_id,
        role: accepted.role,
      };
    },
  },
];

function requestedTenant(definition: RouteDefinition, request: FastifyRequest): string | undefined {
  if (definition.tenantSource === 'none') return undefined;
  if (definition.tenantSource === 'header') {
    const value = request.headers['x-tenant-id'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const value = (request.params as Record<string, unknown>)[definition.tenantSource.param];
  return typeof value === 'string' ? value : undefined;
}

export type RouteDispatcher = (
  definition: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

export function registerRoutes(app: FastifyInstance, dispatch: RouteDispatcher): void {
  for (const definition of ROUTES) {
    app.route({
      method: definition.method,
      url: definition.url,
      schema: definition.schema as never,
      config: definition.config as never,
      handler: (request, reply) => dispatch(definition, request, reply),
    });
  }
}

export function tenantForRequest(
  definition: RouteDefinition,
  request: FastifyRequest,
): string | undefined {
  return requestedTenant(definition, request);
}
