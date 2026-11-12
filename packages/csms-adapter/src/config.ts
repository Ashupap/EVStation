export interface CsmsAdapterConfig {
  baseUrl: string;
  hasuraUrl: string;
  authMode: 'localDev' | 'jwt';
  tokenUrl: string;
  provisionerClientId: string;
  provisionerClientSecret: string;
  readerClientId: string;
  readerClientSecret: string;
  tenantId: number;
  timeoutMs: number;
  amqpUrl: string;
  ingestQueue: string;
  maxRetries: number;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`invalid CSMS configuration: ${name} is required`);
  return value;
}

export function loadCsmsAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv = env.NODE_ENV ?? 'development',
): CsmsAdapterConfig {
  const authMode = (env.CSMS_AUTH_MODE ?? 'localDev') as 'localDev' | 'jwt';
  if (authMode !== 'localDev' && authMode !== 'jwt') {
    throw new Error('invalid CSMS configuration: CSMS_AUTH_MODE must be localDev or jwt');
  }
  if (authMode === 'localDev' && nodeEnv !== 'development') {
    throw new Error('invalid CSMS configuration: localDev auth is only allowed in development');
  }
  const tenantId = Number(env.CSMS_TENANT_ID ?? '1');
  if (!Number.isSafeInteger(tenantId) || tenantId < 1) {
    throw new Error('invalid CSMS configuration: CSMS_TENANT_ID must be a positive integer');
  }
  return {
    baseUrl: (env.CSMS_BASE_URL ?? 'http://localhost:8088').replace(/\/$/, ''),
    hasuraUrl: (env.CSMS_HASURA_URL ?? 'http://localhost:8090/v1/graphql').replace(/\/$/, ''),
    authMode,
    tokenUrl: (
      env.CSMS_TOKEN_URL ?? 'http://localhost:8180/realms/evstation/protocol/openid-connect/token'
    ).replace(/\/$/, ''),
    provisionerClientId: required(env.CSMS_PROVISIONER_CLIENT_ID, 'CSMS_PROVISIONER_CLIENT_ID'),
    provisionerClientSecret: required(
      env.CSMS_PROVISIONER_CLIENT_SECRET,
      'CSMS_PROVISIONER_CLIENT_SECRET',
    ),
    readerClientId: required(env.CSMS_READER_CLIENT_ID, 'CSMS_READER_CLIENT_ID'),
    readerClientSecret: required(env.CSMS_READER_CLIENT_SECRET, 'CSMS_READER_CLIENT_SECRET'),
    tenantId,
    timeoutMs: Number(env.CSMS_TIMEOUT_MS ?? '10000'),
    amqpUrl: env.CSMS_AMQP_URL ?? 'amqp://guest:guest@localhost:5672',
    ingestQueue: env.CSMS_INGEST_QUEUE ?? 'evstation.ingest',
    maxRetries: Number(env.CSMS_INGEST_MAX_RETRIES ?? '5'),
  };
}
