import pg from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiDb } from './db.js';
import type { ApiConfig } from './config.js';
import { AppError } from './errors.js';
import { loadPrincipal, loadSiteScope } from './principal.js';
import { setActorContext, setTenantContext } from './context.js';

interface Scope {
  actorId: string;
  email: string;
  tenantId: string;
  role: 'tenant_admin' | 'site_manager' | 'viewer';
  siteIds: string[];
  tokenExpiresAt: number | null;
}

interface Connection {
  id: string;
  scope: Scope;
  response: FastifyReply;
  raw: FastifyReply['raw'];
  chain: Promise<void>;
  closed: boolean;
  keepalive?: NodeJS.Timeout;
  refresh?: NodeJS.Timeout;
  expiry?: NodeJS.Timeout;
}

interface NotifyPayload {
  v?: number;
  id?: string;
  kind?: string;
  tenant_id?: string;
  site_id?: string;
  station_id?: string;
  session_id?: string | null;
  occurred_at?: string;
}

const CHANNEL = 'evstation_events';
const MAX_BUFFER_BYTES = 256 * 1024;
const KEEPALIVE_MS = 15_000;
const REFRESH_MS = 30_000;
const MAX_PER_USER = Number(process.env.SSE_MAX_PER_USER ?? '10');
const MAX_PER_TENANT = Number(process.env.SSE_MAX_PER_TENANT ?? '250');
const MAX_PER_PROCESS = Number(process.env.SSE_MAX_PROCESS ?? '2000');

export interface SseMetrics {
  connections: number;
  notified: number;
  droppedNotVisible: number;
  droppedQueueFull: number;
  resyncs: number;
  backpressureCloses: number;
  rereadMs: number[];
}

export class SseHub {
  private readonly connections = new Map<string, Connection>();
  private listener: pg.Client | null = null;
  private listenerStopping = false;
  private listenerRetry = 1_000;
  private readonly metrics: SseMetrics = {
    connections: 0,
    notified: 0,
    droppedNotVisible: 0,
    droppedQueueFull: 0,
    resyncs: 0,
    backpressureCloses: 0,
    rereadMs: [],
  };

  constructor(
    private readonly db: ApiDb,
    private readonly config: ApiConfig,
  ) {}

  async start(): Promise<void> {
    await this.connectListener();
  }

  async close(): Promise<void> {
    this.listenerStopping = true;
    for (const connection of this.connections.values())
      this.closeConnection(connection, 'server_shutdown');
    await this.listener?.end().catch(() => undefined);
  }

  snapshot() {
    const sorted = this.metrics.rereadMs.slice().sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;
    return {
      sse_connections: this.connections.size,
      events_notified: this.metrics.notified,
      events_dropped_not_visible: this.metrics.droppedNotVisible,
      events_dropped_queue_full: this.metrics.droppedQueueFull,
      resyncs: this.metrics.resyncs,
      backpressure_closes: this.metrics.backpressureCloses,
      reread_p50_ms: q(0.5),
      reread_p95_ms: q(0.95),
    };
  }

  async open(scope: Scope, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (this.connections.size >= MAX_PER_PROCESS) {
      throw new AppError(429, 'SSE_PROCESS_LIMIT', 'too many event streams in this process');
    }
    let userCount = 0;
    let tenantCount = 0;
    for (const connection of this.connections.values()) {
      if (connection.scope.actorId === scope.actorId) userCount += 1;
      if (connection.scope.tenantId === scope.tenantId) tenantCount += 1;
    }
    if (userCount >= MAX_PER_USER) {
      throw new AppError(429, 'SSE_USER_LIMIT', 'too many event streams for this user');
    }
    if (tenantCount >= MAX_PER_TENANT) {
      throw new AppError(429, 'SSE_TENANT_LIMIT', 'too many event streams for this tenant');
    }

    reply.hijack();
    const id = crypto.randomUUID();
    const connection: Connection = {
      id,
      scope,
      response: reply,
      raw: reply.raw,
      chain: Promise.resolve(),
      closed: false,
    };
    this.connections.set(id, connection);
    try {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
        'x-request-id': request.id,
      });
      reply.raw.write(': connected\n\n');
    } catch (error) {
      throw error;
    }
    if (request.headers['last-event-id'])
      this.send(connection, 'resync', { reason: 'last-event-id' });
    connection.keepalive = setInterval(
      () => this.sendRaw(connection, ': keepalive\n\n'),
      KEEPALIVE_MS,
    );
    connection.refresh = setInterval(() => void this.refresh(connection), REFRESH_MS);
    if (scope.tokenExpiresAt) {
      connection.expiry = setTimeout(
        () => this.closeConnection(connection, 'token_expired'),
        Math.max(0, scope.tokenExpiresAt - Date.now()),
      );
    }
    reply.raw.on('close', () => this.closeConnection(connection, 'client_closed'));
    reply.raw.on('error', () => this.closeConnection(connection, 'client_error'));
  }

  private async connectListener(): Promise<void> {
    if (this.listenerStopping) return;
    const client = new pg.Client({ connectionString: this.config.databaseUrlApp });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
      this.listenerRetry = 1_000;
      client.on('notification', (message) => {
        if (message.payload) void this.handleNotification(message.payload);
      });
      client.on('error', () => this.reconnectListener());
      client.on('end', () => this.reconnectListener());
      setInterval(() => {
        void client.query('SELECT 1').catch(() => this.reconnectListener());
      }, KEEPALIVE_MS).unref();
      this.resyncAll('listen_connected');
    } catch {
      await client.end().catch(() => undefined);
      this.reconnectListener();
    }
  }

  private reconnectListener(): void {
    if (this.listenerStopping) return;
    const old = this.listener;
    this.listener = null;
    void old?.end().catch(() => undefined);
    const delay = this.listenerRetry;
    this.listenerRetry = Math.min(this.listenerRetry * 2, 30_000);
    setTimeout(() => void this.connectListener(), delay + Math.floor(Math.random() * 250));
  }

  private resyncAll(reason: string): void {
    this.metrics.resyncs += 1;
    for (const connection of this.connections.values()) this.send(connection, 'resync', { reason });
  }

  private async handleNotification(raw: string): Promise<void> {
    let payload: NotifyPayload;
    try {
      payload = JSON.parse(raw) as NotifyPayload;
    } catch {
      return;
    }
    if (
      !payload.kind ||
      !payload.tenant_id ||
      !payload.site_id ||
      !payload.station_id ||
      !payload.occurred_at
    ) {
      return;
    }
    const candidates = [...this.connections.values()].filter(
      (connection) =>
        connection.scope.tenantId === payload.tenant_id &&
        (connection.scope.role === 'tenant_admin' ||
          connection.scope.siteIds.includes(payload.site_id!)),
    );
    if (candidates.length === 0) return;
    const started = performance.now();
    const row = await this.reread(candidates[0].scope.actorId, payload);
    this.metrics.rereadMs.push(performance.now() - started);
    if (this.metrics.rereadMs.length > 1000) this.metrics.rereadMs.shift();
    if (!row) {
      this.metrics.droppedNotVisible += 1;
      return;
    }
    for (const connection of this.connections.values()) {
      if (connection.closed) continue;
      if (connection.scope.tenantId !== row.tenant_id) continue;
      if (
        connection.scope.role !== 'tenant_admin' &&
        !connection.scope.siteIds.includes(row.site_id)
      ) {
        continue;
      }
      this.send(
        connection,
        payload.kind,
        { tenant_id: row.tenant_id, site_id: row.site_id, ...row.data },
        payload.id,
      );
    }
    this.metrics.notified += 1;
  }

  private async reread(
    actorId: string,
    payload: NotifyPayload,
  ): Promise<{ tenant_id: string; site_id: string; data: Record<string, unknown> } | null> {
    return this.db.transaction(async (client) => {
      await setActorContext(client, actorId);
      await setTenantContext(client, payload.tenant_id ?? '');
      if (payload.kind === 'station.connection') {
        const { rows } = await client.query<{
          tenant_id: string;
          site_id: string;
          station_id: string;
          connection_state: string;
          last_seen_at: Date | null;
          last_event_csms_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT tenant_id, site_id, station_id, connection_state, last_seen_at,
                  last_event_csms_at, updated_at
           FROM app.station_runtime_state
           WHERE station_id = $1 AND tenant_id = $2`,
          [payload.station_id, payload.tenant_id],
        );
        const row = rows[0];
        return row
          ? {
              tenant_id: row.tenant_id,
              site_id: row.site_id,
              data: {
                station_id: row.station_id,
                connection_state: row.connection_state,
                last_seen_at: row.last_seen_at,
                last_event_csms_at: row.last_event_csms_at,
                updated_at: row.updated_at,
              },
            }
          : null;
      }
      if (payload.kind === 'station.status') {
        const { rows } = await client.query<{
          tenant_id: string;
          site_id: string;
          station_id: string;
          connector_number: number | null;
          status: string;
          error_code: string | null;
          csms_timestamp: Date;
          updated_at: Date;
        }>(
          `SELECT e.tenant_id, e.site_id, e.station_id, c.connector_number, e.status,
                  e.error_code, e.csms_timestamp, e.csms_timestamp AS updated_at
           FROM app.station_status_events e
           LEFT JOIN app.connectors c ON c.id = e.connector_id
           WHERE e.station_id = $1 AND e.tenant_id = $2 AND e.csms_timestamp = $3
           ORDER BY e.id DESC LIMIT 1`,
          [payload.station_id, payload.tenant_id, payload.occurred_at],
        );
        const row = rows[0];
        return row
          ? {
              tenant_id: row.tenant_id,
              site_id: row.site_id,
              data: {
                station_id: row.station_id,
                connector_number: row.connector_number,
                status: row.status,
                error_code: row.error_code,
                csms_timestamp: row.csms_timestamp,
                updated_at: row.updated_at,
              },
            }
          : null;
      }
      if (payload.kind?.startsWith('session.') && payload.session_id) {
        const { rows } = await client.query<{
          tenant_id: string;
          site_id: string;
          station_id: string;
          id: string;
          status: string;
          stop_reason: string | null;
          energy_wh: string;
          started_at: Date;
          ended_at: Date | null;
          updated_at: Date;
        }>(
          `SELECT tenant_id, site_id, station_id, id, status, stop_reason, energy_wh::text,
                  started_at, ended_at, updated_at
           FROM app.sessions WHERE id = $1 AND tenant_id = $2`,
          [payload.session_id, payload.tenant_id],
        );
        const row = rows[0];
        return row
          ? {
              tenant_id: row.tenant_id,
              site_id: row.site_id,
              data: {
                session_id: row.id,
                station_id: row.station_id,
                status: row.status,
                stop_reason: row.stop_reason,
                energy_wh: Number(row.energy_wh),
                started_at: row.started_at,
                ended_at: row.ended_at,
                updated_at: row.updated_at,
              },
            }
          : null;
      }
      return null;
    });
  }

  private send(
    connection: Connection,
    event: string,
    data: Record<string, unknown>,
    eventId?: string,
  ): void {
    const frame = `${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ version: 1, type: event, ...data })}\n\n`;
    this.sendRaw(connection, frame);
  }

  private sendRaw(connection: Connection, frame: string): void {
    if (connection.closed) return;
    if (connection.raw.writableLength > MAX_BUFFER_BYTES) {
      this.metrics.backpressureCloses += 1;
      this.closeConnection(connection, 'backpressure');
      return;
    }
    connection.chain = connection.chain
      .then(async () => {
        if (connection.closed) return;
        connection.response.raw.write(frame);
      })
      .catch(() => this.closeConnection(connection, 'write_error'));
  }

  private closeConnection(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection.id);
    if (connection.keepalive) clearInterval(connection.keepalive);
    if (connection.refresh) clearInterval(connection.refresh);
    if (connection.expiry) clearTimeout(connection.expiry);
    if (reason !== 'client_closed' && reason !== 'client_error') {
      connection.response.raw.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
    }
    connection.response.raw.end();
  }

  private async refresh(connection: Connection): Promise<void> {
    if (connection.closed) return;
    if (connection.scope.tokenExpiresAt && connection.scope.tokenExpiresAt <= Date.now()) {
      this.closeConnection(connection, 'token_expired');
      return;
    }
    try {
      const checked = await this.db.transaction(async (client) => {
        await setActorContext(client, connection.scope.actorId);
        await setTenantContext(client, connection.scope.tenantId);
        const principal = await loadPrincipal(client, {
          sub: connection.scope.actorId,
          email: '',
          email_verified: true,
        });
        const membership = principal.memberships.find(
          (item) => item.tenantId === connection.scope.tenantId,
        );
        if (!membership) return { reason: 'membership_removed' as const };
        if (membership.tenantStatus === 'suspended') return { reason: 'tenant_suspended' as const };
        if (!['tenant_admin', 'site_manager', 'viewer'].includes(membership.role)) {
          return { reason: 'role_demoted' as const };
        }
        const siteIds =
          membership.role === 'tenant_admin' ? [] : await loadSiteScope(client, principal);
        return { membership, siteIds };
      });
      if ('reason' in checked) {
        this.closeConnection(connection, checked.reason ?? 'membership_removed');
        return;
      }
      if (
        connection.scope.role !== 'tenant_admin' &&
        connection.scope.siteIds.some((siteId) => !checked.siteIds.includes(siteId))
      ) {
        this.closeConnection(connection, 'site_scope_lost');
        return;
      }
      connection.scope.role = checked.membership.role;
      connection.scope.siteIds = checked.siteIds;
    } catch {
      this.closeConnection(connection, 'scope_refresh_failed');
    }
  }
}
