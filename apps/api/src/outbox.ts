import type { PoolClient } from 'pg';
import type { ApiDb } from './db.js';
import type { Mailer } from './mailer.js';

export interface QueuedInvitation {
  tenantId: string;
  invitationId: string;
  recipient: string;
  acceptUrl: string;
  expiresAt: Date;
}

export interface OutboxJob {
  id: string;
  tenant_id: string;
  invitation_id: string;
  recipient: string;
  accept_url: string;
  expires_at: Date;
  attempts: number;
}

export interface OutboxLogger {
  error(fields: Record<string, unknown>, message: string): void;
  info?(fields: Record<string, unknown>, message: string): void;
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

async function claimForId(db: ApiDb, outboxId: string): Promise<OutboxJob | undefined> {
  const { rows } = await db.query<OutboxJob>(
    `SELECT id, tenant_id, invitation_id, recipient, accept_url, expires_at, attempts
     FROM app.claim_email_outbox_for_id($1)`,
    [outboxId],
  );
  return rows[0];
}

async function deliver(
  db: ApiDb,
  job: OutboxJob,
  mailer: Mailer,
  maxAttempts: number,
): Promise<boolean> {
  try {
    await mailer.sendInvitation({
      invitationId: job.invitation_id,
      tenantId: job.tenant_id,
      to: job.recipient,
      acceptUrl: job.accept_url,
      expiresAt: job.expires_at,
    });
  } catch {
    await db.query('SELECT app.fail_email_outbox($1, $2, $3)', [
      job.id,
      'delivery failed',
      maxAttempts,
    ]);
    return false;
  }

  await db.query('SELECT app.complete_email_outbox($1)', [job.id]);
  return true;
}

export async function dispatchInvitationEmail(options: {
  db: ApiDb;
  outboxId: string;
  mailer: Mailer;
  maxAttempts?: number;
  onFailure: () => void;
}): Promise<boolean> {
  const { db, outboxId, mailer, maxAttempts = 5, onFailure } = options;
  const job = await claimForId(db, outboxId);
  if (!job) return false;
  const delivered = await deliver(db, job, mailer, maxAttempts);
  if (!delivered) onFailure();
  return delivered;
}

export interface OutboxBatchResult {
  claimed: number;
  delivered: number;
  failed: number;
}

export async function runOutboxBatch(options: {
  db: ApiDb;
  mailer: Mailer;
  batchSize?: number;
  maxAttempts?: number;
  logger: OutboxLogger;
}): Promise<OutboxBatchResult> {
  const { db, mailer, batchSize = 20, maxAttempts = 5, logger } = options;
  const { rows } = await db.query<OutboxJob>(
    `SELECT id, tenant_id, invitation_id, recipient, accept_url, expires_at, attempts
     FROM app.claim_email_outbox($1)`,
    [batchSize],
  );

  let delivered = 0;
  for (const job of rows) {
    try {
      if (await deliver(db, job, mailer, maxAttempts)) {
        delivered += 1;
      } else {
        logger.error({ outboxId: job.id }, 'invitation email dispatch failed');
      }
    } catch {
      logger.error({ outboxId: job.id }, 'invitation email dispatch failed');
    }
  }

  return { claimed: rows.length, delivered, failed: rows.length - delivered };
}

export interface OutboxWorker {
  stop(): void;
}

export function startOutboxWorker(options: {
  db: ApiDb;
  mailer: Mailer;
  logger: OutboxLogger;
  intervalMs?: number;
  retentionDays?: number;
  batchSize?: number;
  maxAttempts?: number;
}): OutboxWorker {
  const {
    db,
    mailer,
    logger,
    intervalMs = 5_000,
    retentionDays = 30,
    batchSize = 20,
    maxAttempts = 5,
  } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pruning = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runOutboxBatch({ db, mailer, logger, batchSize, maxAttempts });
      if (!pruning) {
        pruning = true;
        try {
          await db.query('SELECT app.prune_email_outbox($1)', [retentionDays]);
        } catch {
          logger.error({}, 'email outbox retention failed');
        } finally {
          pruning = false;
        }
      }
    } catch {
      logger.error({}, 'email outbox worker tick failed');
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = setTimeout(() => void tick(), 0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
