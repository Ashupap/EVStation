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
const InvitationParams = z.object({ tenantId: uuid, invitationId: uuid }).strict();
const TenantParams = z.object({ tenantId: uuid }).strict();

interface RouteContext {
  request: FastifyRequest;
  reply: FastifyReply;
  client: PoolClient;
  db: ApiDb;
  principal: Principal;
  tenantId: string | undefined;
  config: ApiConfig;
  mailer: Mailer;
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
