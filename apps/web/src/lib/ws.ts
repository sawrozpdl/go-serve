// WebSocket client.
//
// Connects to /ws?tenant=<slug> using the session cookie. On reconnect,
// uses exponential backoff. On message, invalidates the appropriate
// TanStack Query keys so consumers refetch.
//
// Events do NOT carry full state — they are cache-bust hints. The query
// re-fetch is the source of truth.

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { API_BASE } from './api';
import { useTenant } from './tenant';

type WSEvent = {
  topic: 'kitchen' | 'tables' | 'orders';
  action: string;
  ref?: { order_id?: string; item_id?: string; service_table_id?: string };
};

/**
 * Mount this once at the app root (after auth + tenant are resolved).
 * It owns a single WS connection that lives as long as the tenant slug
 * is set. Every received event is mapped to a TanStack Query
 * invalidation so the affected views re-fetch fresh data.
 */
export function useRealtime() {
  const qc = useQueryClient();
  const { slug } = useTenant();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const closedByUs = useRef(false);
  const attempts = useRef(0);

  useEffect(() => {
    if (!slug) return;
    closedByUs.current = false;

    // In prod the WS origin is the API origin (e.g. wss://api.cafe.com).
    // In dev API_BASE is empty, so fall back to the page origin and let the
    // Vite proxy upgrade /ws to the API container.
    const wsOrigin = (API_BASE || location.origin).replace(/^http/, 'ws');
    const url = `${wsOrigin}/ws?tenant=${encodeURIComponent(slug)}`;

    const connect = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts.current = 0;
      };
      ws.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data as string) as WSEvent;
          dispatch(qc, slug, ev);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (closedByUs.current) return;
        const delay = Math.min(30_000, 1000 * Math.pow(2, attempts.current));
        attempts.current += 1;
        reconnectTimer.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        // The close handler will fire next; nothing else to do here.
      };
    };

    connect();

    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [slug, qc]);
}

function dispatch(qc: QueryClient, slug: string, ev: WSEvent) {
  // Topic → query invalidations. Stays narrow to avoid refetch storms;
  // a coarse hammer (invalidate everything) would be simpler but cause
  // unnecessary requests on busy floors.
  switch (ev.topic) {
    case 'kitchen':
      qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
      break;
    case 'tables':
      qc.invalidateQueries({ queryKey: ['tables', slug] });
      // Floor view also reads orders to overlay tab amounts.
      qc.invalidateQueries({ queryKey: ['orders'] });
      break;
    case 'orders': {
      qc.invalidateQueries({ queryKey: ['orders'] });
      const orderID = ev.ref?.order_id;
      if (orderID) {
        qc.invalidateQueries({ queryKey: ['order', slug, orderID] });
      }
      // Item-level changes come on this topic too — refresh kitchen tickets.
      if (ev.action.startsWith('order.item.') || ev.action === 'order.items.sent') {
        qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
      }
      break;
    }
  }
}
