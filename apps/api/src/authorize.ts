import { AppError } from './errors.js';
import type { Principal, Role } from './principal.js';
import { membershipFor } from './principal.js';

export type Capability =
  | 'tenant.read'
  | 'tenant.create'
  | 'tenant.update'
  | 'me.read'
  | 'me.update'
  | 'site.read'
  | 'site.create'
  | 'site.update'
  | 'site.delete'
  | 'user.read'
  | 'user.role.update'
  | 'invitation.read'
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.accept'
  | 'audit.read'
  | 'station.read'
  | 'station.create'
  | 'station.update'
  | 'station.credentials.rotate'
  | 'session.read';

export interface Resource {
  tenantId?: string;
  siteId?: string;
}

export function roleFor(principal: Principal, tenantId: string): Role | 'platform_admin' | null {
  if (principal.isPlatformAdmin) return 'platform_admin';
  return membershipFor(principal, tenantId)?.role ?? null;
}

export function authorize(
  principal: Principal,
  tenantId: string | undefined,
  capability: Capability,
  resource: Resource = {},
): boolean {
  if (
    capability === 'me.read' ||
    capability === 'me.update' ||
    capability === 'invitation.accept'
  ) {
    return principal.id.length > 0;
  }

  if (capability.startsWith('tenant.')) {
    return principal.isPlatformAdmin;
  }

  if (!tenantId) return false;
  const role = roleFor(principal, tenantId);

  switch (capability) {
    case 'site.read':
      return role !== null;
    case 'site.create':
    case 'site.delete':
      return role === 'tenant_admin' || role === 'platform_admin';
    case 'site.update':
      if (role === 'tenant_admin' || role === 'platform_admin') return true;
      if (role !== 'site_manager' || !resource.siteId) return false;
      return membershipFor(principal, tenantId)?.siteIds.includes(resource.siteId) === true;
    case 'station.read':
    case 'session.read':
      return role !== null;
    case 'station.update':
      return role === 'tenant_admin' || role === 'platform_admin' || role === 'site_manager';
    case 'station.create':
    case 'station.credentials.rotate':
      return role === 'tenant_admin' || role === 'platform_admin';
    case 'user.read':
    case 'user.role.update':
    case 'invitation.read':
    case 'invitation.create':
    case 'invitation.revoke':
    case 'audit.read':
      return role === 'tenant_admin' || role === 'platform_admin';
    default:
      return false;
  }
}

export function requireCapability(
  principal: Principal,
  tenantId: string | undefined,
  capability: Capability,
  resource: Resource = {},
): void {
  if (!authorize(principal, tenantId, capability, resource)) {
    throw new AppError(403, 'FORBIDDEN', 'not permitted');
  }
}
