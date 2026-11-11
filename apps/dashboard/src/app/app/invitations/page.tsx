import { headers } from 'next/headers';
import { z } from 'zod';
import { EmptyState, PageHeader } from '@/components/page-header';
import { apiFetch, parseApiJson } from '@/lib/api';
import { requireTenant } from '@/lib/auth';
import { invitationSchema } from '@/lib/types';

export const dynamic = 'force-dynamic';

const responseSchema = z.object({ invitations: z.array(invitationSchema) });

function stateOf(invitation: z.infer<typeof invitationSchema>): string {
  if (invitation.accepted_at) return 'Accepted';
  if (invitation.revoked_at) return 'Revoked';
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return 'Expired';
  return 'Pending';
}

export default async function InvitationsPage() {
  const auth = await requireTenant(['tenant_admin']);
  const response = await apiFetch(
    auth.session,
    `/tenants/${auth.tenantId}/invitations`,
    { method: 'GET' },
    new Headers(await headers()),
  );
  const data = await parseApiJson(response, responseSchema);

  return (
    <div>
      <PageHeader
        eyebrow="Access"
        title="Invitations"
        description="Pending and historical invitations for this tenant. Invitation emails are delivered by the API outbox worker."
      />
      {data.invitations.length === 0 ? (
        <EmptyState
          title="No invitations"
          body="Invite flows arrive with the full tenant administration screens."
        />
      ) : (
        <div className="mt-8 space-y-3">
          {data.invitations.map((invitation) => (
            <div
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div>
                <p className="font-semibold text-slate-900">{invitation.email}</p>
                <p className="text-xs capitalize text-slate-500">
                  {invitation.role.replace('_', ' ')} · expires{' '}
                  {new Date(invitation.expires_at).toLocaleDateString()}
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                {stateOf(invitation)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
