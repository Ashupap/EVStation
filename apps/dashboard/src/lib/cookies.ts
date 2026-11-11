import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import type { DashboardConfig } from './config';

const LOGIN_TTL_SECONDS = 10 * 60;

export async function readSessionCookie(config: DashboardConfig): Promise<string | undefined> {
  const store = await cookies();
  return store.get(config.sessionCookieName)?.value;
}

export async function readLoginCookie(config: DashboardConfig): Promise<string | undefined> {
  const store = await cookies();
  return store.get(config.loginCookieName)?.value;
}

export function setSessionCookie(
  response: NextResponse,
  sessionId: string,
  config: DashboardConfig,
): void {
  response.cookies.set({
    name: config.sessionCookieName,
    value: sessionId,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionAbsoluteTtlSeconds,
  });
}

export function clearSessionCookie(response: NextResponse, config: DashboardConfig): void {
  response.cookies.set({
    name: config.sessionCookieName,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: 0,
  });
}

export function setLoginCookie(
  response: NextResponse,
  transactionId: string,
  config: DashboardConfig,
): void {
  response.cookies.set({
    name: config.loginCookieName,
    value: transactionId,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: LOGIN_TTL_SECONDS,
  });
}

export function clearLoginCookie(response: NextResponse, config: DashboardConfig): void {
  response.cookies.set({
    name: config.loginCookieName,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: 0,
  });
}
