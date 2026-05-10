// Package realtime is the WebSocket hub.
//
// One WS endpoint at /ws. Each connected client lives in zero or more
// per-tenant topics (e.g., "kitchen", "tables"). Handlers (orders.go etc.)
// publish events into a topic; the hub fans them out to all subscribers
// of that tenant + topic.
//
// Events do NOT carry full state — they're cache-bust hints. Clients
// re-fetch the affected resource via REST. This costs an extra round-trip
// but eliminates an entire class of stale-state-from-WS bugs.
package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// Topic is one of a small enumerated set, per the design.
type Topic string

const (
	TopicKitchen Topic = "kitchen"
	TopicTables  Topic = "tables"
	TopicOrders  Topic = "orders"
)

// Event is the wire format. Action is descriptive ("order.item.sent",
// "order.opened", etc.). Ref carries optional IDs for cache-key building.
type Event struct {
	Topic  Topic          `json:"topic"`
	Action string         `json:"action"`
	Ref    map[string]any `json:"ref,omitempty"`
}

// client represents one WS connection.
type client struct {
	conn     *websocket.Conn
	tenantID uuid.UUID
	topics   map[Topic]struct{}
	send     chan Event
	closeCh  chan struct{}
}

// Hub fans events out across clients. Goroutine-safe.
type Hub struct {
	mu     sync.RWMutex
	logger *slog.Logger
	// tenantID → topic → set of clients
	subs map[uuid.UUID]map[Topic]map[*client]struct{}
}

func New(logger *slog.Logger) *Hub {
	return &Hub{
		logger: logger,
		subs:   make(map[uuid.UUID]map[Topic]map[*client]struct{}),
	}
}

func (h *Hub) subscribe(c *client, t Topic) {
	h.mu.Lock()
	defer h.mu.Unlock()
	bucket := h.subs[c.tenantID]
	if bucket == nil {
		bucket = make(map[Topic]map[*client]struct{})
		h.subs[c.tenantID] = bucket
	}
	set := bucket[t]
	if set == nil {
		set = make(map[*client]struct{})
		bucket[t] = set
	}
	set[c] = struct{}{}
	c.topics[t] = struct{}{}
}

func (h *Hub) unsubscribeAll(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	bucket := h.subs[c.tenantID]
	if bucket == nil {
		return
	}
	for t := range c.topics {
		if set, ok := bucket[t]; ok {
			delete(set, c)
			if len(set) == 0 {
				delete(bucket, t)
			}
		}
	}
	if len(bucket) == 0 {
		delete(h.subs, c.tenantID)
	}
}

// Broadcast sends an event to all clients subscribed to (tenantID, topic).
// Slow clients are dropped from the topic — backpressure isn't worth the
// complexity here; we'd rather drop than block all other subscribers.
func (h *Hub) Broadcast(tenantID uuid.UUID, ev Event) {
	h.mu.RLock()
	bucket := h.subs[tenantID]
	if bucket == nil {
		h.mu.RUnlock()
		return
	}
	clients := bucket[ev.Topic]
	if len(clients) == 0 {
		h.mu.RUnlock()
		return
	}
	// Snapshot to avoid holding the lock while sending.
	snap := make([]*client, 0, len(clients))
	for c := range clients {
		snap = append(snap, c)
	}
	h.mu.RUnlock()

	for _, c := range snap {
		select {
		case c.send <- ev:
		default:
			// Slow client; close it. The reader/writer goroutines will exit.
			h.logger.Warn("ws client backpressure, dropping", "tenant", tenantID)
			h.disconnect(c)
		}
	}
}

func (h *Hub) disconnect(c *client) {
	select {
	case <-c.closeCh:
		return
	default:
		close(c.closeCh)
	}
	_ = c.conn.Close(websocket.StatusPolicyViolation, "slow consumer")
}

// runClient owns one connection's read+write goroutines until close.
func (h *Hub) runClient(ctx context.Context, c *client) {
	defer h.unsubscribeAll(c)
	defer close(c.send)

	// Reader goroutine — we don't expect messages from the client right
	// now, but reading drains the connection so close frames arrive.
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, err := c.conn.Read(ctx); err != nil {
				return
			}
		}
	}()

	// Writer loop.
	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	writeCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	for {
		select {
		case <-c.closeCh:
			return
		case <-readDone:
			return
		case <-pingTicker.C:
			pingCtx, cancelPing := context.WithTimeout(writeCtx, 5*time.Second)
			err := c.conn.Ping(pingCtx)
			cancelPing()
			if err != nil {
				return
			}
		case ev, ok := <-c.send:
			if !ok {
				return
			}
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			wctx, wcancel := context.WithTimeout(writeCtx, 5*time.Second)
			err = c.conn.Write(wctx, websocket.MessageText, b)
			wcancel()
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					h.logger.Debug("ws write failed", "err", err)
				}
				return
			}
		}
	}
}

// newClient constructs a client and starts its lifecycle goroutine. The
// caller should add it to topics before/after calling this — both are safe.
func (h *Hub) newClient(ctx context.Context, conn *websocket.Conn, tenantID uuid.UUID, topics []Topic) *client {
	c := &client{
		conn:     conn,
		tenantID: tenantID,
		topics:   make(map[Topic]struct{}, len(topics)),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	for _, t := range topics {
		h.subscribe(c, t)
	}
	go h.runClient(ctx, c)
	return c
}
