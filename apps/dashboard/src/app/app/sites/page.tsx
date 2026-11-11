import { headers } from 'next/headers';
import { z } from 'zod';
import { EmptyState, PageHeader } from '@/components/page-header';
import { apiFetch, parseApiJson } from '@/lib/api';
import { requireTenant } from '@/lib/auth';
import { siteSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

const responseSchema = z.object({ sites: z.array(siteSchema) });

export default async function SitesPage() {
  const auth = await requireTenant();
  const response = await apiFetch(
    auth.session,
    '/sites',
    { method: 'GET' },
    new Headers(await headers()),
  );
  const data = await parseApiJson(response, responseSchema);

  return (
    <div>
      <PageHeader
        eyebrow="Sites"
        title="Charging sites"
        description={`Sites available to ${auth.membership.tenant_name} under your current site scope.`}
      />
      {data.sites.length === 0 ? (
        <EmptyState
          title="No sites yet"
          body="Site management arrives in the operations phase. Your tenant has no sites in this shell."
        />
      ) : (
        <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-5 py-3 font-semibold">Name</th>
                <th className="px-5 py-3 font-semibold">Address</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.sites.map((site) => (
                <tr key={site.id}>
                  <td className="px-5 py-4 font-semibold text-slate-900">{site.name}</td>
                  <td className="px-5 py-4 text-slate-600">{site.address || '—'}</td>
                  <td className="px-5 py-4 capitalize text-slate-600">{site.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
