// WebSocket client.
//
// Connects to /ws?tenant=<slug> using the session cookie. On reconnect,
// uses exponential backoff. On message, invalidates the appropriate
// TanStack Query keys so consumers refetch.
//
// HTTP fallback: when the WS fails to open POLL_AFTER_FAILURES times in a
// row (network block, edge proxy that won't upgrade, etc.) we start
// polling the same query keys at POLL_INTERVAL_MS so the UI keeps moving.
// Reconnect attempts continue in the background; the moment the WS opens
// again the polling stops.
//
// Events do NOT carry full state — they are cache-bust hints. The query
// re-fetch is the source of truth.

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

// After this many connect attempts that never reached `onopen`, switch to
// HTTP polling. Keep low enough that a user on a flaky network sees data
// flow within ~10–15 s, high enough that a single dropped packet doesn't
// trigger the slower path.
const POLL_AFTER_FAILURES = 3;

// Polling cadence when the WS is unreachable. Matches the "good enough for
// a busy floor" feel without hammering the API.
const POLL_INTERVAL_MS = 5000;

import { API_BASE } from './api';
import { useTenant } from './tenant';

// WS_BASE is the explicit origin for the WebSocket. It exists because REST
// and WS can need different origins in prod: REST often goes through a
// CDN/edge rewrite (e.g. Vercel rewrites /api/* to the API), but WebSocket
// upgrades are not proxied by most edge platforms — they 502 or just fail.
// Set VITE_WS_BASE_URL to the direct API origin (e.g. wss://api.cafe.com)
// when REST is proxied. Falls back to API_BASE, then to the page origin.
const WS_BASE = (import.meta.env.VITE_WS_BASE_URL ?? '').replace(/\/+$/, '');

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
  const pollTimer = useRef<number | null>(null);
  const closedByUs = useRef(false);
  const attempts = useRef(0);
  // Consecutive connections that closed without ever opening. Resets on a
  // successful open; used to decide when to spin up HTTP polling.
  const failedOpens = useRef(0);
  // Per-connection flag: did this socket reach onopen? Distinguishes
  // "couldn't connect" from "connected then dropped" in onclose.
  const openedOnce = useRef(false);

  useEffect(() => {
    if (!slug) return;
    closedByUs.current = false;
    failedOpens.current = 0;

    const apiBaseIsAbsolute = /^https?:\/\//i.test(API_BASE);
    const rawOrigin = WS_BASE || (apiBaseIsAbsolute ? API_BASE : location.origin);
    const wsOrigin = rawOrigin.replace(/^http/i, 'ws');
    const url = `${wsOrigin}/ws?tenant=${encodeURIComponent(slug)}`;

    const stopPolling = () => {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    const startPolling = () => {
      if (pollTimer.current !== null) return;
      // Fire one immediate refresh so users don't wait the full interval
      // for the first sync after we fall back.
      pollAll(qc, slug);
      pollTimer.current = window.setInterval(() => pollAll(qc, slug), POLL_INTERVAL_MS);
    };

    const connect = () => {
      openedOnce.current = false;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts.current = 0;
        failedOpens.current = 0;
        openedOnce.current = true;
        stopPolling();
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
        if (!openedOnce.current) {
          failedOpens.current += 1;
          if (failedOpens.current >= POLL_AFTER_FAILURES) startPolling();
        }
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
      stopPolling();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [slug, qc]);
}

// pollAll invalidates the same query families the WS dispatcher targets,
// so the UI stays close to live even when the socket is unreachable.
//
// invalidateQueries does a prefix match and (by default) only refetches
// queries that are currently mounted, so this is cheap when the user
// isn't looking at a given view — at most one round-trip per active
// query family per tick.
function pollAll(qc: QueryClient, slug: string) {
  qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
  qc.invalidateQueries({ queryKey: ['tables', slug] });
  qc.invalidateQueries({ queryKey: ['orders'] });
  // Single-order detail (TabPage) uses ['order', slug, orderId]; prefix
  // match covers any open detail tab without us tracking which one.
  qc.invalidateQueries({ queryKey: ['order'] });
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
