import type { PoolClient } from 'pg';
import { setActorContext } from './context.js';
import type { ApiDb } from './db.js';
import type { Principal } from './principal.js';

export interface AuditEvent {
  tenantId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export async function writeAudit(
  client: PoolClient,
  principal: Principal,
  event: AuditEvent,
): Promise<void> {
  const details = {
    ...event.details,
    ...(principal.isPlatformAdmin && event.tenantId !== null
      ? { acting_as_platform_admin: true }
      : {}),
  };
  await client.query(
    `INSERT INTO app.audit_log
       (tenant_id, actor_id, action, resource_type, resource_id, outcome, request_id, details)
     VALUES ($1, $2, $3, $4, $5, 'allowed', $6, $7::jsonb)`,
    [
      event.tenantId,
      principal.id,
      event.action,
      event.resourceType ?? null,
      event.resourceId ?? null,
      event.requestId ?? null,
      JSON.stringify(details),
    ],
  );
}

export async function writeDeniedAudit(
  db: ApiDb,
  principal: Principal,
  event: Omit<AuditEvent, 'tenantId'> & { attemptedTenantId?: string },
): Promise<void> {
  try {
    await db.transaction(async (client) => {
      await setActorContext(client, principal.id);
      await client.query(
        `INSERT INTO app.audit_log
           (tenant_id, actor_id, action, resource_type, resource_id, outcome, request_id, details)
         VALUES (NULL, $1, $2, $3, $4, 'denied', $5, $6::jsonb)`,
        [
          principal.id,
          event.action,
          event.resourceType ?? null,
          event.resourceId ?? null,
          event.requestId ?? null,
          JSON.stringify({
            ...event.details,
            ...(event.attemptedTenantId ? { attempted_tenant: event.attemptedTenantId } : {}),
          }),
        ],
      );
    });
  } catch {
    // Denied-attempt auditing must never mask the original response.
  }
}
