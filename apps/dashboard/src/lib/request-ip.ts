import { isIP } from 'node:net';
import type { DashboardConfig } from './config';

function forwardedIps(headers: Headers): string[] {
  const value = headers.get('x-forwarded-for');
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/^\[(.*)\]$/u, '$1'))
    .filter((entry) => entry.length > 0);
}

function resolveForwardedIp(headers: Headers, hops: number): string | undefined {
  const addresses = forwardedIps(headers);
  if (addresses.length < hops) return undefined;
  const selected = addresses[addresses.length - hops];
  if (!selected || isIP(selected) === 0) return undefined;
  return selected;
}

export function clientIp(headers: Headers, config: DashboardConfig): string {
  if (config.trustProxy === false) return 'direct';
  return resolveForwardedIp(headers, config.trustProxy) ?? 'direct';
}

export function endUserIp(headers: Headers, config: DashboardConfig): string | undefined {
  if (config.trustProxy === false) return undefined;
  return resolveForwardedIp(headers, config.trustProxy);
}
