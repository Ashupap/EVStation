import type { NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth';
import { loadDashboardConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

function retryDelay(): number {
  return 3_000 + Math.floor(Math.random() * 2_000);
}

export async function GET(request: NextRequest) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'cross-origin stream rejected' } }),
      {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
  const session = await getServerSession();
  if (!session) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'sign in required' } }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
  const config = loadDashboardConfig();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort);

  let upstream: Response;
  try {
    upstream = await fetch(new URL('/events', `${config.apiBaseUrl}/`), {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${session.session.accessToken}`,
        accept: 'text/event-stream',
        ...(session.session.tenantId ? { 'x-tenant-id': session.session.tenantId } : {}),
        ...(request.headers.get('last-event-id')
          ? { 'last-event-id': request.headers.get('last-event-id') as string }
          : {}),
      },
    });
  } catch {
    request.signal.removeEventListener('abort', abort);
    return new Response(
      JSON.stringify({
        error: { code: 'EVENTS_UNAVAILABLE', message: 'event stream unavailable' },
      }),
      { status: 502, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    );
  }
  if (!upstream.ok || !upstream.body) {
    request.signal.removeEventListener('abort', abort);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const retry = new TextEncoder().encode(`retry: ${retryDelay()}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(streamController) {
      streamController.enqueue(retry);
      const reader = upstream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          streamController.enqueue(value);
        }
        streamController.close();
      } catch (error) {
        streamController.error(error);
      } finally {
        request.signal.removeEventListener('abort', abort);
        reader.releaseLock();
      }
    },
    cancel() {
      controller.abort();
      request.signal.removeEventListener('abort', abort);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
