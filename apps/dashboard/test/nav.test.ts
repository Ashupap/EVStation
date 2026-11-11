import { describe, expect, it } from 'vitest';
import { navItems } from '../src/lib/nav.js';
import type { Membership, Principal } from '../src/lib/types.js';

const tenantA = '10000000-0000-4000-8000-000000000001';

function membership(role: Membership['role']): Membership {
  return {
    tenant_id: tenantA,
    tenant_name: 'Tenant Alpha',
    tenant_slug: 'tenant-alpha',
    role,
    site_ids: [],
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: '90000000-0000-4000-8000-000000000001',
    email: 'user@example.com',
    display_name: null,
    email_verified: true,
    is_platform_admin: false,
    memberships: [],
    ...overrides,
  };
}

describe('role-aware navigation', () => {
  it('shows sites to every tenant role', () => {
    for (const role of ['viewer', 'site_manager', 'tenant_admin'] as const) {
      expect(navItems(principal(), membership(role)).map((item) => item.label)).toContain('Sites');
    }
  });

  it('shows user and invitation management only to tenant admins', () => {
    expect(navItems(principal(), membership('viewer')).map((item) => item.label)).toEqual([
      'Sites',
    ]);
    expect(navItems(principal(), membership('site_manager')).map((item) => item.label)).toEqual([
      'Sites',
    ]);
    expect(navItems(principal(), membership('tenant_admin')).map((item) => item.label)).toEqual([
      'Sites',
      'Users',
      'Invitations',
    ]);
  });

  it('shows the platform tenant directory only to platform admins', () => {
    expect(
      navItems(principal({ is_platform_admin: true }), undefined).map((item) => item.label),
    ).toEqual(['Tenants']);
  });
});
