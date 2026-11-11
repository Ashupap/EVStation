import type { Membership, Principal } from './types';

export interface NavItem {
  href: string;
  label: string;
  testId: string;
}

export function navItems(principal: Principal, membership: Membership | undefined): NavItem[] {
  const items: NavItem[] = [];
  if (membership) {
    items.push({ href: '/app/sites', label: 'Sites', testId: 'nav-sites' });
  }
  if (membership?.role === 'tenant_admin') {
    items.push(
      { href: '/app/users', label: 'Users', testId: 'nav-users' },
      { href: '/app/invitations', label: 'Invitations', testId: 'nav-invitations' },
    );
  }
  if (principal.is_platform_admin) {
    items.push({ href: '/app/tenants', label: 'Tenants', testId: 'nav-tenants' });
  }
  return items;
}
