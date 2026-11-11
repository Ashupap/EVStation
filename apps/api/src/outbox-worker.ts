import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { assertRuntimeRole, createDb } from './db.js';
import type { Mailer } from './mailer.js';
import { startOutboxWorker } from './outbox.js';

const databaseUrl = process.env.DATABASE_URL_APP;
const mailerModule = process.env.OUTBOX_MAILER_MODULE;
if (!databaseUrl) throw new Error('DATABASE_URL_APP is required');
if (!mailerModule) throw new Error('OUTBOX_MAILER_MODULE is required');

const loaded = (await import(pathToFileURL(resolve(mailerModule)).href)) as {
  createMailer?: () => Mailer | Promise<Mailer>;
};
if (typeof loaded.createMailer !== 'function') {
  throw new Error('OUTBOX_MAILER_MODULE must export createMailer(): Mailer');
}

const db = createDb(databaseUrl, 4);
await assertRuntimeRole(db.pool);
const mailer = await loaded.createMailer();
const worker = startOutboxWorker({
  db,
  mailer,
  intervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 5_000),
  retentionDays: Number(process.env.OUTBOX_RETENTION_DAYS ?? 30),
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5),
  logger: {
    error(fields, message) {
      process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`);
    },
  },
});

const shutdown = async (signal: string) => {
  worker.stop();
  await db.close();
  process.stdout.write(`${JSON.stringify({ level: 'info', message: 'worker stopped', signal })}\n`);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
