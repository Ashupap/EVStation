import type { DashboardConfig } from './config';

export function clientIp(headers: Headers, config: DashboardConfig): string {
  if (!config.trustProxy) return 'direct';
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get('x-real-ip')?.trim() || 'direct';
}

export function endUserIp(headers: Headers, config: DashboardConfig): string | undefined {
  if (!config.trustProxy) return undefined;
  const ip = clientIp(headers, config);
  return ip === 'direct' ? undefined : ip;
}
