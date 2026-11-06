import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import type { Capability } from './authorize.js';
import { requireCapability } from './authorize.js';
import type { ApiConfig } from './config.js';
import { AppError } from './errors.js';
import type { Principal, Role } from './principal.js';

const uuid = z.string().uuid();
const role = z.enum(['tenant_admin', 'site_manager', 'viewer']);

const TenantCreate = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
});
const TenantUpdate = z.object({
  status: z.enum(['active', 'suspended']),
});
const MeUpdate = z.object({
  display_name: z.string().trim().min(1).max(200).nullable(),
});
const SiteCreate = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const SiteUpdate = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
const RoleUpdate = z.object({ role });
const InvitationCreate = z.object({
  email: z.string().trim().email().max(320),
  role,
  site_ids: z.array(uuid).max(100).default([]),
});
const InvitationAccept = z.object({ token: z.string().min(20).max(512) });
const IdParams = z.object({ id: uuid });
const InvitationParams = z.object({ tenantId: uuid, invitationId: uuid });
const TenantParams = z.object({ tenantId: uuid });

interface RouteContext {
  request: FastifyRequest;
  reply: FastifyReply;
  client: PoolClient;
  principal: Principal;
  tenantId: string | undefined;
  config: ApiConfig;
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
    schema: { tags: ['tenants'] },
    async handler({ client, principal, tenantId }) {
      requireCapability(principal, tenantId, 'tenant.read');
      const { rows } = await client.query(
        `SELECT id, name, slug, status, created_at, updated_at
         FROM app.tenants ORDER BY name, id`,
      );
      return { tenants: rows };
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
      requireCapability(principal, undefined, 'tenant.create');
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
      requireCapability(principal, undefined, 'tenant.update');
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
    schema: { tags: ['sites'] },
    async handler({ client, principal, tenantId }) {
      requireCapability(principal, tenantId, 'site.read');
      const { rows } = await client.query(
        `SELECT id, tenant_id, name, address, status, created_at, updated_at
         FROM app.sites ORDER BY name, id`,
      );
      return { sites: rows };
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
      requireCapability(principal, tenantId, 'site.create');
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
      requireCapability(principal, tenantId, 'site.read');
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
      const { rows } = await client.query(
        `UPDATE app.sites SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, tenant_id, name, address, status, created_at, updated_at`,
        values,
      );
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
    schema: { tags: ['users'] },
    async handler({ client, principal, tenantId }) {
      requireCapability(principal, tenantId, 'user.read');
      const { rows } = await client.query(
        `SELECT u.id, u.email, u.display_name, m.id AS membership_id, m.role,
                coalesce(array_agg(ms.site_id) FILTER (WHERE ms.site_id IS NOT NULL), '{}')
                  AS site_ids
         FROM app.memberships m
         JOIN app.users u ON u.id = m.user_id
         LEFT JOIN app.membership_sites ms ON ms.membership_id = m.id
         WHERE m.tenant_id = $1
         GROUP BY u.id, u.email, u.display_name, m.id, m.role
         ORDER BY u.display_name NULLS LAST, u.email, u.id`,
        [tenantId],
      );
      return { users: rows };
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
      requireCapability(principal, tenantId, 'user.role.update');
      const params = IdParams.parse(request.params);
      const body = RoleUpdate.parse(request.body);
      const current = await client.query<{ role: Role }>(
        'SELECT role FROM app.memberships WHERE tenant_id = $1 AND user_id = $2',
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
      await writeAudit(client, principal, {
        tenantId: tenantId ?? null,
        action: 'user.role_changed',
        resourceType: 'user',
        resourceId: params.id,
        requestId: request.id,
        details: { from: previous.role, to: body.role },
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
    async handler({ client, principal, tenantId }) {
      requireCapability(principal, tenantId, 'invitation.read');
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
    async handler({ client, principal, tenantId, request, reply, config }) {
      requireCapability(principal, tenantId, 'invitation.create');
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
        ...(config.nodeEnv === 'production'
          ? {}
          : { accept_url: `${config.invitationAcceptBaseUrl}?token=${token}` }),
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
      requireCapability(principal, tenantId, 'invitation.revoke');
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
