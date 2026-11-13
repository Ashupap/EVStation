import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function databaseUrl(
  user: string,
  password: string | undefined,
  env: Record<string, string>,
): string {
  if (!password) throw new Error(`worker configuration: missing password for ${user}`);
  const host = env.OUR_DB_HOST ?? 'localhost';
  const port = env.OUR_DB_HOST_PORT ?? '5432';
  const name = env.OUR_DB_NAME ?? 'evstation';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

export interface WorkerConfig {
  ingestDatabaseUrl: string;
  jobsDatabaseUrl: string;
  amqpUrl: string;
  queue: string;
  maxRetries: number;
  healthPort: number;
  jobIntervalMs: number;
  meterRetentionDays: number;
  statusRetentionDays: number;
  ledgerRetentionDays: number;
  staleSessionSeconds: number;
  offlineTimeoutSeconds: number;
  idTagRetentionDays: number;
  rejectionRetentionDays: number;
  amqpManagementUrl: string;
  rabbitmqUser: string;
  rabbitmqPassword: string;
  queueDepthAlertThreshold: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const compose = readEnvFile(path.join(repoRoot, 'infra/compose/.env'));
  const merged: Record<string, string> = { ...compose };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  const ingestUrl =
    merged.DATABASE_URL_INGEST ??
    databaseUrl('evstation_ingest', merged.OUR_DB_INGEST_PASSWORD, merged);
  const jobsUrl =
    merged.DATABASE_URL_JOBS ?? databaseUrl('evstation_jobs', merged.OUR_DB_JOBS_PASSWORD, merged);
  const amqpUrl =
    merged.CSMS_AMQP_URL ??
    (merged.OUR_AMQP_WORKER_PASSWORD
      ? `amqp://evstation_worker:${encodeURIComponent(merged.OUR_AMQP_WORKER_PASSWORD)}@localhost:5672`
      : 'amqp://guest:guest@localhost:5672');
  const number = (name: string, fallback: number): number => {
    const value = Number(merged[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`worker configuration: ${name} must be a positive number`);
    }
    return value;
  };
  return {
    ingestDatabaseUrl: ingestUrl,
    jobsDatabaseUrl: jobsUrl,
    amqpUrl,
    queue: merged.CSMS_INGEST_QUEUE ?? 'evstation.ingest',
    maxRetries: number('CSMS_INGEST_MAX_RETRIES', 5),
    healthPort: number('WORKER_HEALTH_PORT', 4100),
    jobIntervalMs: number('WORKER_JOB_INTERVAL_MS', 60_000),
    meterRetentionDays: number('METER_RETENTION_DAYS', 365),
    statusRetentionDays: number('STATUS_EVENT_RETENTION_DAYS', 90),
    ledgerRetentionDays: number('INGESTION_LEDGER_RETENTION_DAYS', 30),
    staleSessionSeconds: number('STALE_SESSION_SECONDS', 86_400),
    offlineTimeoutSeconds: number('STATION_OFFLINE_TIMEOUT_SECONDS', 300),
    idTagRetentionDays: number('ID_TAG_RETENTION_DAYS', 365),
    rejectionRetentionDays: number('INGESTION_REJECTION_RETENTION_DAYS', 30),
    amqpManagementUrl: merged.RABBITMQ_MGMT_URL ?? 'http://127.0.0.1:15672/api',
    rabbitmqUser: merged.RABBITMQ_MONITOR_USER ?? 'evstation_monitor',
    rabbitmqPassword:
      merged.RABBITMQ_MONITOR_PASS ?? merged.OUR_AMQP_MONITOR_PASSWORD ?? 'unavailable',
    queueDepthAlertThreshold: number('QUEUE_DEPTH_ALERT_THRESHOLD', 10000),
  };
}
