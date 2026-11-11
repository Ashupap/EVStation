import { headers } from 'next/headers';
import { z } from 'zod';
import { EmptyState, PageHeader } from '@/components/page-header';
import { apiFetch, parseApiJson } from '@/lib/api';
import { requirePlatformAdmin } from '@/lib/auth';
import { tenantSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

const responseSchema = z.object({ tenants: z.array(tenantSchema) });

export default async function TenantsPage() {
  const auth = await requirePlatformAdmin();
  const response = await apiFetch(
    { ...auth.session, tenantId: undefined },
    '/tenants',
    { method: 'GET' },
    new Headers(await headers()),
  );
  const data = await parseApiJson(response, responseSchema);

  return (
    <div>
      <PageHeader
        eyebrow="Platform"
        title="Tenant directory"
        description="Every tenant in the EVStation deployment. Tenant-scoped screens require an explicit membership selection."
      />
      {data.tenants.length === 0 ? (
        <EmptyState title="No tenants" body="No tenants have been created in this environment." />
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {data.tenants.map((tenant) => (
            <div
              key={tenant.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black text-slate-950">{tenant.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{tenant.slug}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold capitalize text-slate-700">
                  {tenant.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
