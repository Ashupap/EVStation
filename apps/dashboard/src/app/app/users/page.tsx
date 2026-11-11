import { headers } from 'next/headers';
import { z } from 'zod';
import { EmptyState, PageHeader } from '@/components/page-header';
import { apiFetch, parseApiJson } from '@/lib/api';
import { requireTenant } from '@/lib/auth';
import { userSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

const responseSchema = z.object({ users: z.array(userSchema) });

export default async function UsersPage() {
  const auth = await requireTenant(['tenant_admin']);
  const response = await apiFetch(
    auth.session,
    '/users',
    { method: 'GET' },
    new Headers(await headers()),
  );
  const data = await parseApiJson(response, responseSchema);

  return (
    <div>
      <PageHeader
        eyebrow="Access"
        title="Tenant users"
        description="Operators with a membership in this tenant. Role and site changes are enforced by the database and API."
      />
      {data.users.length === 0 ? (
        <EmptyState title="No users" body="This tenant has no memberships yet." />
      ) : (
        <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3 font-semibold">User</th>
                <th className="px-5 py-3 font-semibold">Role</th>
                <th className="px-5 py-3 font-semibold">Site scope</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.users.map((user) => (
                <tr key={user.id}>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">
                      {user.display_name || user.email}
                    </p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </td>
                  <td className="px-5 py-4 capitalize text-slate-600">
                    {user.role.replace('_', ' ')}
                  </td>
                  <td className="px-5 py-4 text-slate-600">
                    {user.role === 'site_manager' ? `${user.site_ids.length} site(s)` : 'All sites'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
