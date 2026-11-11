import Link from 'next/link';
import { EmptyState, PageHeader } from '@/components/page-header';
import { activeMembership, requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const auth = await requireAuth();
  const membership = activeMembership(auth.principal, auth.session);

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title={`Welcome, ${auth.principal.display_name || auth.principal.email.split('@')[0]}`}
        description="This Phase 1 shell establishes secure access, tenant context and role-aware navigation. Charging operations screens arrive in later phases."
      />

      {membership ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold tracking-wide text-slate-500 uppercase">Tenant</p>
            <p className="mt-2 text-lg font-black text-slate-950">{membership.tenant_name}</p>
            <p className="mt-1 text-xs text-slate-500">{membership.tenant_slug}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold tracking-wide text-slate-500 uppercase">Your role</p>
            <p className="mt-2 text-lg font-black capitalize text-slate-950">
              {membership.role.replace('_', ' ')}
            </p>
            <p className="mt-1 text-xs text-slate-500">Scoped by the EVStation API</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-bold tracking-wide text-slate-500 uppercase">Session</p>
            <p className="mt-2 text-lg font-black text-slate-950">Server-side</p>
            <p className="mt-1 text-xs text-slate-500">Tokens stay outside your browser</p>
          </div>
        </div>
      ) : (
        <EmptyState
          title="Select a tenant"
          body="Choose one of your tenant memberships from the sidebar to open tenant-scoped navigation."
        />
      )}

      {auth.principal.is_platform_admin ? (
        <div className="mt-8 rounded-3xl border border-cyan-200 bg-cyan-50/70 p-6">
          <p className="text-sm font-bold text-cyan-950">Platform administration</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-cyan-900/80">
            Platform administrators can review the tenant directory without selecting a tenant.
          </p>
          <Link
            href="/app/tenants"
            className="mt-4 inline-flex rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-cyan-800"
          >
            Open tenant directory
          </Link>
        </div>
      ) : null}
    </div>
  );
}
