'use client';

import { useEffect, useRef, useState } from 'react';

const TERMINAL_REASONS = new Set(['membership_removed', 'tenant_suspended', 'site_scope_lost']);

export interface StreamEvent {
  version: number;
  type: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface EventStreamState {
  status: 'connecting' | 'open' | 'closed';
  lastEvent: StreamEvent | null;
  closedReason: string | null;
}

export function useEventStream(
  enabled = process.env.NEXT_PUBLIC_SSE_ENABLED !== 'false',
): EventStreamState {
  const [state, setState] = useState<EventStreamState>({
    status: 'closed',
    lastEvent: null,
    closedReason: null,
  });
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      setState((current) => ({ ...current, status: 'connecting', closedReason: null }));
      const source = new EventSource('/api/events');
      sourceRef.current = source;
      source.onopen = () => setState((current) => ({ ...current, status: 'open' }));
      const handle = (event: MessageEvent<string>) => {
        try {
          setState((current) => ({
            ...current,
            lastEvent: JSON.parse(event.data) as StreamEvent,
          }));
        } catch {
          // Ignore malformed frames; the next resync/refetch is authoritative.
        }
      };
      source.addEventListener('resync', handle as EventListener);
      for (const type of [
        'station.connection',
        'station.status',
        'session.started',
        'session.updated',
        'session.ended',
        'session.meter',
      ]) {
        source.addEventListener(type, handle as EventListener);
      }
      source.addEventListener('closed', (event) => {
        let reason = 'closed';
        try {
          reason =
            (JSON.parse((event as MessageEvent<string>).data) as { reason?: string }).reason ??
            reason;
        } catch {
          /* keep generic */
        }
        setState((current) => ({ ...current, status: 'closed', closedReason: reason }));
        if (TERMINAL_REASONS.has(reason)) {
          source.close();
          return;
        }
        source.close();
        const delay = 2_000 + Math.floor(Math.random() * 3_000);
        reconnectTimer = setTimeout(connect, delay);
      });
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sourceRef.current?.close();
    };
  }, [enabled]);

  return state;
}
