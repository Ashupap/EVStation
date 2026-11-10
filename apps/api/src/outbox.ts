import type { PoolClient } from 'pg';
import { setActorContext, setTenantContext } from './context.js';
import type { ApiDb } from './db.js';
import type { Mailer } from './mailer.js';

export interface QueuedInvitation {
  tenantId: string;
  invitationId: string;
  recipient: string;
  acceptUrl: string;
  expiresAt: Date;
}

export async function queueInvitationEmail(
  client: PoolClient,
  invitation: QueuedInvitation,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO app.email_outbox
       (tenant_id, invitation_id, recipient, accept_url, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      invitation.tenantId,
      invitation.invitationId,
      invitation.recipient,
      invitation.acceptUrl,
      invitation.expiresAt,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('email outbox insert returned no row');
  return row.id;
}

interface OutboxRow {
  invitation_id: string;
  tenant_id: string;
  recipient: string;
  accept_url: string;
  expires_at: Date;
}

export async function dispatchInvitationEmail(options: {
  db: ApiDb;
  actorId: string;
  tenantId: string;
  outboxId: string;
  mailer: Mailer;
  onFailure: () => void;
}): Promise<void> {
  const { db, actorId, tenantId, outboxId, mailer, onFailure } = options;
  let row: OutboxRow | undefined;

  await db.transaction(async (client) => {
    await setActorContext(client, actorId);
    await setTenantContext(client, tenantId);
    const result = await client.query<OutboxRow>(
      `SELECT invitation_id, tenant_id, recipient, accept_url, expires_at
       FROM app.email_outbox
       WHERE id = $1 AND dispatched_at IS NULL`,
      [outboxId],
    );
    row = result.rows[0];
  });

  if (!row) return;

  try {
    await mailer.sendInvitation({
      invitationId: row.invitation_id,
      tenantId: row.tenant_id,
      to: row.recipient,
      acceptUrl: row.accept_url,
      expiresAt: row.expires_at,
    });
  } catch {
    onFailure();
    await db
      .transaction(async (client) => {
        await setActorContext(client, actorId);
        await setTenantContext(client, tenantId);
        await client.query(
          "UPDATE app.email_outbox SET last_error = 'delivery failed' WHERE id = $1",
          [outboxId],
        );
      })
      .catch(() => undefined);
    return;
  }

  await db.transaction(async (client) => {
    await setActorContext(client, actorId);
    await setTenantContext(client, tenantId);
    await client.query(
      'UPDATE app.email_outbox SET dispatched_at = now(), last_error = NULL WHERE id = $1',
      [outboxId],
    );
  });
}
