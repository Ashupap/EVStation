import Link from 'next/link';
import type { AuthContext } from '@/lib/auth';
import { activeMembership } from '@/lib/auth';
import { navItems } from '@/lib/nav';

function Brand() {
  return (
    <Link href="/app" className="flex items-center gap-3 rounded-2xl px-2 py-1">
      <span className="grid size-10 place-items-center rounded-2xl bg-cyan-600 text-lg font-black text-white shadow-lg shadow-cyan-600/20">
        EV
      </span>
      <span>
        <span className="block text-sm font-black tracking-tight text-slate-950">EVStation</span>
        <span className="block text-xs text-slate-500">Operations console</span>
      </span>
    </Link>
  );
}

export function Sidebar({ auth }: { auth: AuthContext }) {
  const membership = activeMembership(auth.principal, auth.session);
  const items = navItems(auth.principal, membership);
  const activeMemberships = auth.principal.memberships;

  return (
    <aside className="flex w-full flex-col gap-8 border-b border-slate-200 bg-white/90 p-5 backdrop-blur lg:min-h-screen lg:w-72 lg:border-r lg:border-b-0">
      <Brand />

      <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Signed in</p>
        <p className="mt-2 truncate text-sm font-semibold text-slate-900">
          {auth.principal.display_name || auth.principal.email}
        </p>
        <p className="truncate text-xs text-slate-500">{auth.principal.email}</p>
        {auth.principal.is_platform_admin ? (
          <span className="mt-3 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
            Platform admin
          </span>
        ) : null}
      </div>

      <nav className="flex flex-col gap-1" aria-label="Main navigation">
        {items.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
            Select a tenant to continue.
          </p>
        ) : null}
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testId}
            className="rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-cyan-50 hover:text-cyan-800"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto space-y-4">
        {activeMemberships.length > 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Active tenant
            </p>
            <p className="mt-2 truncate text-sm font-semibold text-slate-900">
              {membership?.tenant_name ?? 'Not selected'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {membership ? membership.role.replace('_', ' ') : 'Choose a tenant'}
            </p>
            {activeMemberships.length > 1 ? (
              <form action="/api/tenant" method="post" className="mt-3 flex gap-2">
                <select
                  name="tenantId"
                  defaultValue={membership?.tenant_id ?? ''}
                  aria-label="Tenant"
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-medium text-slate-700"
                >
                  <option value="">Choose tenant</option>
                  {activeMemberships.map((item) => (
                    <option key={item.tenant_id} value={item.tenant_id}>
                      {item.tenant_name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  data-testid="tenant-switch"
                  className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-700"
                >
                  Switch
                </button>
              </form>
            ) : null}
          </div>
        ) : null}

        <form action="/auth/logout" method="post">
          <button
            type="submit"
            data-testid="logout"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
