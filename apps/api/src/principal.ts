import type { PoolClient } from 'pg';
import type { TokenClaims } from './auth.js';
import { setTenantContext } from './context.js';
import { AppError } from './errors.js';

export type Role = 'tenant_admin' | 'site_manager' | 'viewer';

export interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: 'active' | 'suspended';
  role: Role;
  siteIds: string[];
}

export interface Principal {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  memberships: Membership[];
}

interface ActorRow {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

interface MembershipRow {
  tenant_id: string;
  role: Role;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
}

export async function loadPrincipal(client: PoolClient, claims: TokenClaims): Promise<Principal> {
  const actor = await client.query<ActorRow>(
    `SELECT id, email, display_name, email_verified
     FROM app.ensure_actor($1, $2, $3, $4)`,
    [claims.sub, claims.email, claims.email_verified, null],
  );
  const user = actor.rows[0];
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'actor could not be resolved');

  const platform = await client.query<{ is_platform_admin: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM app.platform_admins WHERE user_id = $1) AS is_platform_admin',
    [user.id],
  );
  const memberships = await client.query<MembershipRow>(
    `SELECT m.tenant_id, m.role, t.name, t.slug, t.status
     FROM app.memberships m
     JOIN app.tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1
     ORDER BY t.name, m.tenant_id`,
    [user.id],
  );

  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    emailVerified: user.email_verified,
    isPlatformAdmin: platform.rows[0]?.is_platform_admin === true,
    memberships: memberships.rows.map((row) => ({
      tenantId: row.tenant_id,
      tenantName: row.name,
      tenantSlug: row.slug,
      tenantStatus: row.status,
      role: row.role,
      siteIds: [],
    })),
  };
}

export function membershipFor(principal: Principal, tenantId: string): Membership | undefined {
  return principal.memberships.find((membership) => membership.tenantId === tenantId);
}

export async function loadSiteScope(client: PoolClient, principal: Principal): Promise<string[]> {
  if (principal.isPlatformAdmin) return [];
  const { rows } = await client.query<{ site_id: string }>(
    'SELECT site_id FROM app.membership_sites WHERE membership_id = app.actor_membership_id()',
  );
  return rows.map((row) => row.site_id);
}

export async function resolveTenant(
  client: PoolClient,
  principal: Principal,
  requestedTenantId: string | undefined,
  required: boolean,
): Promise<string | undefined> {
  let tenantId = requestedTenantId;

  if (!tenantId && required) {
    if (principal.isPlatformAdmin) {
      throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
    }
    if (principal.memberships.length === 1) {
      tenantId = principal.memberships[0]?.tenantId;
    } else if (principal.memberships.length === 0) {
      throw new AppError(403, 'TENANT_REQUIRED', 'no tenant membership is available');
    } else {
      throw new AppError(400, 'TENANT_REQUIRED', 'X-Tenant-Id is required');
    }
  }
  if (!tenantId) return undefined;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new AppError(400, 'INVALID_TENANT', 'tenant id must be a UUID');
  }

  if (!principal.isPlatformAdmin) {
    const membership = membershipFor(principal, tenantId);
    if (!membership) throw new AppError(403, 'TENANT_FORBIDDEN', 'tenant is not available');
    if (membership.tenantStatus !== 'active') {
      throw new AppError(403, 'TENANT_SUSPENDED', 'tenant is suspended');
    }
    await setTenantContext(client, tenantId);
    const siteIds = await loadSiteScope(client, principal);
    membership.siteIds = siteIds;
    return tenantId;
  }

  const tenant = await client.query<{ status: 'active' | 'suspended' }>(
    'SELECT status FROM app.tenants WHERE id = $1',
    [tenantId],
  );
  const row = tenant.rows[0];
  if (!row) throw new AppError(403, 'TENANT_FORBIDDEN', 'tenant is not available');
  if (row.status !== 'active') {
    throw new AppError(403, 'TENANT_SUSPENDED', 'tenant is suspended');
  }
  await setTenantContext(client, tenantId);
  return tenantId;
}
