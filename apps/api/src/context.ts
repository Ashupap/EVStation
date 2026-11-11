import type { PoolClient } from 'pg';

/**
 * The only place the API writes tenant-context GUCs. Always transaction-local:
 * `set_config(..., true)` is reset by COMMIT/ROLLBACK, so a recycled pool
 * connection can never inherit another request's actor or tenant.
 */
export async function setActorContext(client: PoolClient, actorId: string): Promise<void> {
  await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
}

export async function setTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}
