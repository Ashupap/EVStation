import { describe, expect, it } from 'vitest';
import { authorize, type Capability } from '../src/authorize.js';
import type { Principal, Role } from '../src/principal.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const OTHER_SITE = '20000000-0000-4000-8000-000000000002';

function principal(role: Role | 'platform_admin'): Principal {
  const isPlatformAdmin = role === 'platform_admin';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'user@example.com',
    displayName: null,
    emailVerified: true,
    isPlatformAdmin,
    memberships: isPlatformAdmin
      ? []
      : [
          {
            tenantId: TENANT,
            tenantName: 'Acme',
            tenantSlug: 'acme',
            tenantStatus: 'active',
            role,
            siteIds: [SITE],
          },
        ],
  };
}

const capabilities: Capability[] = [
  'tenant.read',
  'tenant.create',
  'tenant.update',
  'me.read',
  'me.update',
  'site.read',
  'site.create',
  'site.update',
  'site.delete',
  'user.read',
  'user.role.update',
  'invitation.read',
  'invitation.create',
  'invitation.revoke',
  'audit.read',
];

describe('permission matrix (one assertion per role per capability)', () => {
  it('platform admin may use every capability', () => {
    for (const capability of capabilities) {
      expect(
        authorize(principal('platform_admin'), TENANT, capability, { siteId: OTHER_SITE }),
        capability,
      ).toBe(true);
    }
  });

  it('tenant admin may manage sites/users/invitations/audit, never tenants', () => {
    const allowed = new Set<Capability>([
      'me.read',
      'me.update',
      'site.read',
      'site.create',
      'site.update',
      'site.delete',
      'user.read',
      'user.role.update',
      'invitation.read',
      'invitation.create',
      'invitation.revoke',
      'audit.read',
    ]);
    for (const capability of capabilities) {
      expect(authorize(principal('tenant_admin'), TENANT, capability, { siteId: OTHER_SITE })).toBe(
        allowed.has(capability),
      );
    }
  });

  it('site manager may read and edit only sites in scope', () => {
    const allowed = new Set<Capability>(['me.read', 'me.update', 'site.read', 'site.update']);
    for (const capability of capabilities) {
      expect(authorize(principal('site_manager'), TENANT, capability, { siteId: SITE })).toBe(
        allowed.has(capability),
      );
    }
    expect(
      authorize(principal('site_manager'), TENANT, 'site.update', { siteId: OTHER_SITE }),
    ).toBe(false);
    expect(authorize(principal('site_manager'), TENANT, 'site.update')).toBe(false);
  });

  it('viewer is read-only for sites', () => {
    const allowed = new Set<Capability>(['me.read', 'me.update', 'site.read']);
    for (const capability of capabilities) {
      expect(authorize(principal('viewer'), TENANT, capability)).toBe(allowed.has(capability));
    }
  });

  it('denies tenant-scoped capabilities without a tenant or membership', () => {
    expect(authorize(principal('viewer'), undefined, 'site.read')).toBe(false);
    expect(authorize(principal('viewer'), TENANT, 'site.read')).toBe(true);
  });
});
