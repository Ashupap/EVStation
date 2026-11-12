import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { CsmsEvent } from '@evstation/csms-adapter';
import { normalizeMeterValues } from './meter.js';

const SUPPORTED_ACTIONS = new Set([
  'BootNotification',
  'StatusNotification',
  'Heartbeat',
  'StartTransaction',
  'MeterValues',
  'StopTransaction',
]);

const STATION_REF = /^[A-Za-z0-9-]{1,64}$/;

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampValue(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stationRef(event: CsmsEvent): string | null {
  const value = stringValue(event.body?.ocppConnectionName);
  return value && STATION_REF.test(value) ? value : null;
}

function hash(event: CsmsEvent): string {
  return crypto.createHash('sha256').update(event.raw).digest('hex');
}

async function call(pool: Pool, fn: string, args: unknown[]): Promise<string> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const result = await pool.query<{ result: string }>(
    `SELECT app.${fn}(${placeholders}) AS result`,
    args,
  );
  return result.rows[0]?.result ?? 'accepted';
}

async function reject(pool: Pool, ref: string | null, reason: string, event: CsmsEvent) {
  await call(pool, 'reject_ingest_event', [ref ?? 'INVALID', reason, hash(event)]);
  return 'ack' as const;
}

function eventRef(event: CsmsEvent): string {
  const correlation = stringValue(event.body?.correlationId) ?? 'unknown';
  return `frame:${String(event.body?.direction ?? 'inbound')}:${String(event.body?.action ?? 'unknown')}:${correlation}:0`;
}

export async function handleEvent(
  event: CsmsEvent,
  pool: Pool,
  maxRetries: number,
): Promise<'ack' | 'retry'> {
  const ref = stationRef(event);
  if (event.parseError || !event.body) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
  const body = event.body;
  const kind = stringValue(body.kind);
  const csmsTimestamp = timestampValue(body.timestamp);
  if (!ref || !csmsTimestamp) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
  const payloadHash = hash(event);

  if (kind === 'connection') {
    const state = stringValue(body.state);
    if (state !== 'connected' && state !== 'closed') {
      return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
    }
    const refValue = `connection:${ref}:${state}:${csmsTimestamp}`;
    const result = await call(pool, 'ingest_connection', [
      ref,
      state,
      refValue,
      csmsTimestamp,
      payloadHash,
    ]);
    void result;
    return 'ack';
  }

  if (
    kind !== 'frame' ||
    (body.direction !== 'inbound' &&
      !(body.direction === 'outbound' && body.action === 'StartTransaction'))
  ) {
    return reject(pool, ref, 'UNSUPPORTED_FRAME', event);
  }
  if (body.protocol !== 'ocpp1.6') {
    return reject(pool, ref, 'UNSUPPORTED_OCPP_VERSION', event);
  }
  const action = stringValue(body.action);
  if (!action || !SUPPORTED_ACTIONS.has(action)) {
    return reject(pool, ref, 'UNSUPPORTED_ACTION', event);
  }
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {};
  const correlation = stringValue(body.correlationId);
  if (!correlation) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);

  let result: string;
  switch (action) {
    case 'BootNotification': {
      result = await call(pool, 'ingest_boot', [
        ref,
        eventRef(event),
        csmsTimestamp,
        null,
        stringValue(payload.chargePointVendor),
        stringValue(payload.chargePointModel),
        stringValue(payload.chargePointSerialNumber),
        stringValue(payload.firmwareVersion),
        stringValue(body.protocol),
        payloadHash,
      ]);
      break;
    }
    case 'Heartbeat': {
      result = await call(pool, 'ingest_heartbeat', [
        ref,
        eventRef(event),
        csmsTimestamp,
        payloadHash,
      ]);
      break;
    }
    case 'StatusNotification': {
      const connector = numberValue(payload.connectorId);
      const status = stringValue(payload.status);
      if (connector === null || !status) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
      result = await call(pool, 'ingest_status', [
        ref,
        connector,
        status,
        stringValue(payload.errorCode),
        timestampValue(payload.timestamp) ?? csmsTimestamp,
        eventRef(event),
        csmsTimestamp,
        payloadHash,
      ]);
      break;
    }
    case 'StartTransaction': {
      if (body.direction === 'outbound') {
        const transactionRef = numberValue(payload.transactionId);
        const idTagStatus =
          payload.idTagInfo && typeof payload.idTagInfo === 'object'
            ? stringValue((payload.idTagInfo as Record<string, unknown>).status)
            : null;
        if (transactionRef === null || !idTagStatus) {
          return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
        }
        result = await call(pool, 'ingest_transaction_start_response', [
          ref,
          correlation,
          String(transactionRef),
          idTagStatus,
          eventRef(event),
          csmsTimestamp,
          payloadHash,
        ]);
      } else {
        const connector = numberValue(payload.connectorId);
        const meterStart = numberValue(payload.meterStart);
        if (connector === null || meterStart === null) {
          return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
        }
        result = await call(pool, 'ingest_transaction_start', [
          ref,
          correlation,
          connector,
          stringValue(payload.idTag),
          Math.round(meterStart),
          timestampValue(payload.timestamp) ?? csmsTimestamp,
          eventRef(event),
          csmsTimestamp,
          payloadHash,
        ]);
      }
      break;
    }
    case 'MeterValues': {
      const transactionRef = numberValue(payload.transactionId);
      if (transactionRef === null) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
      let samples;
      try {
        samples = normalizeMeterValues(payload, timestampValue(payload.timestamp) ?? csmsTimestamp);
      } catch {
        return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
      }
      result = await call(pool, 'ingest_meter_values', [
        ref,
        String(transactionRef),
        eventRef(event),
        csmsTimestamp,
        JSON.stringify(samples),
        payloadHash,
      ]);
      break;
    }
    case 'StopTransaction': {
      const transactionRef = numberValue(payload.transactionId);
      if (transactionRef === null) return reject(pool, ref, 'MALFORMED_PAYLOAD', event);
      result = await call(pool, 'ingest_transaction_stop', [
        ref,
        String(transactionRef),
        Math.round(numberValue(payload.meterStop) ?? 0),
        stringValue(payload.reason) ?? 'Unknown',
        timestampValue(payload.timestamp) ?? csmsTimestamp,
        eventRef(event),
        csmsTimestamp,
        payloadHash,
      ]);
      break;
    }
    default:
      return reject(pool, ref, 'UNSUPPORTED_ACTION', event);
  }

  if (result !== 'retry') return 'ack';
  if (event.deathCount < maxRetries) return 'retry';
  await call(pool, 'record_parked_event', [
    ref,
    eventRef(event),
    csmsTimestamp,
    action === 'MeterValues' ? 'meter' : action,
    'RETRY_EXHAUSTED',
    payloadHash,
  ]);
  return 'ack';
}
