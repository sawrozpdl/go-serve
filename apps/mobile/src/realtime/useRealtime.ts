/**
 * Single WebSocket connection for the active tenant. Ported from web's
 * `lib/ws.ts`: fetch a ticket → connect → on event invalidate the mapped query
 * keys → exponential backoff on drop → HTTP-poll fallback after repeated
 * open failures. RN additions: uses the Hermes global `WebSocket` (no polyfill)
 * and reconnects + refreshes on AppState → active (mobile OSes suspend sockets
 * in the background, so a socket that "looks open" may be dead).
 *
 * Events are cache-bust hints; the query refetch is the source of truth.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { mapEventToInvalidations, pollInvalidations, type WSEvent } from '@cafe-mgmt/api-types';
import { useTenantStore } from '../stores/tenant';
import { setConnectivityMode, isOffline } from '../stores/connectivity';
import { getWSTicket, wsUrl } from './ws';

const POLL_AFTER_FAILURES = 3;
const POLL_INTERVAL_MS = 5000;

function invalidate(qc: QueryClient, keys: ReturnType<typeof pollInvalidations>) {
  for (const queryKey of keys) qc.invalidateQueries({ queryKey: [...queryKey] });
}

export function useRealtime() {
  const qc = useQueryClient();
  const slug = useTenantStore((s) => s.active?.slug);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closedByUs = useRef(false);
  const attempts = useRef(0);
  const failedOpens = useRef(0);
  const openedOnce = useRef(false);

  useEffect(() => {
    if (!slug) return;
    closedByUs.current = false;
    failedOpens.current = 0;

    const stopPolling = () => {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    const pollAll = () => invalidate(qc, pollInvalidations(slug));
    const startPolling = () => {
      if (pollTimer.current !== null) return;
      if (!isOffline()) setConnectivityMode('polling');
      pollAll();
      pollTimer.current = setInterval(pollAll, POLL_INTERVAL_MS);
    };

    const scheduleReconnect = () => {
      const delay = Math.min(30_000, 1000 * Math.pow(2, attempts.current));
      attempts.current += 1;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    const connect = async () => {
      openedOnce.current = false;
      let ticket: string;
      try {
        ticket = (await getWSTicket(slug)).ticket;
      } catch {
        if (closedByUs.current) return;
        failedOpens.current += 1;
        if (failedOpens.current >= POLL_AFTER_FAILURES) startPolling();
        scheduleReconnect();
        return;
      }
      if (closedByUs.current) return;

      const ws = new WebSocket(wsUrl(slug, ticket));
      wsRef.current = ws;

      ws.onopen = () => {
        attempts.current = 0;
        failedOpens.current = 0;
        openedOnce.current = true;
        stopPolling();
        setConnectivityMode('ws');
      };
      ws.onmessage = (msg) => {
        try {
          const ev = JSON.parse(String(msg.data)) as WSEvent;
          invalidate(qc, mapEventToInvalidations(ev, slug));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUs.current) return;
        if (!isOffline()) setConnectivityMode('polling');
        if (!openedOnce.current) {
          failedOpens.current += 1;
          if (failedOpens.current >= POLL_AFTER_FAILURES) startPolling();
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose fires next */
      };
    };

    void connect();

    // Foreground heal: sockets suspended in the background are unreliable.
    // On return, refresh immediately and force a fresh connection.
    const onAppState = (state: AppStateStatus) => {
      if (state !== 'active') return;
      pollAll();
      attempts.current = 0;
      if (wsRef.current) {
        wsRef.current.close(); // onclose reconnects promptly (attempts reset)
      } else if (reconnectTimer.current === null) {
        void connect();
      }
    };
    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      stopPolling();
      appSub.remove();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [slug, qc]);
}
