package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/google/uuid"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
)

// discardLogger returns a logger that drops all output.
func discardLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

func newTestHub() *Hub {
	return New(slog.New(slog.DiscardHandler))
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

func TestNew_NotNil(t *testing.T) {
	h := newTestHub()
	if h == nil {
		t.Fatal("New returned nil")
	}
}

func TestNew_EmptySubs(t *testing.T) {
	h := newTestHub()
	h.mu.RLock()
	defer h.mu.RUnlock()
	if len(h.subs) != 0 {
		t.Errorf("subs len = %d, want 0", len(h.subs))
	}
}

// ---------------------------------------------------------------------------
// Broadcast — no subscribers
// ---------------------------------------------------------------------------

func TestBroadcast_NoSubscribers_NoOp(t *testing.T) {
	h := newTestHub()
	// Must not panic or block.
	h.Broadcast(uuid.New(), Event{Topic: TopicKitchen, Action: "order.item.sent"})
}

func TestBroadcast_WrongTenant_NoOp(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	// Register one client manually for a different tenant.
	c := &client{
		tenantID: uuid.New(), // different tenant
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	h.subscribe(c, TopicKitchen)

	// Broadcasting to tid (where no subscriber exists) must not deliver to c.
	h.Broadcast(tid, Event{Topic: TopicKitchen, Action: "test"})

	select {
	case ev := <-c.send:
		t.Errorf("unexpected event delivered: %+v", ev)
	default:
		// correct: nothing delivered
	}
}

func TestBroadcast_CorrectTenantWrongTopic_NoOp(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	h.subscribe(c, TopicKitchen)

	// Broadcast to a topic the client isn't subscribed to.
	h.Broadcast(tid, Event{Topic: TopicFinance, Action: "test"})

	select {
	case ev := <-c.send:
		t.Errorf("unexpected event delivered: %+v", ev)
	default:
		// correct: nothing delivered
	}
}

// ---------------------------------------------------------------------------
// Broadcast — with a subscriber
// ---------------------------------------------------------------------------

func TestBroadcast_DeliveredToSubscriber(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	h.subscribe(c, TopicOrders)

	ev := Event{Topic: TopicOrders, Action: "order.opened", Ref: map[string]any{"order_id": "123"}}
	h.Broadcast(tid, ev)

	select {
	case got := <-c.send:
		if got.Action != ev.Action {
			t.Errorf("action = %q, want %q", got.Action, ev.Action)
		}
		if got.Topic != ev.Topic {
			t.Errorf("topic = %q, want %q", got.Topic, ev.Topic)
		}
	default:
		t.Fatal("event not delivered")
	}
}

func TestBroadcast_MultipleSubscribers(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()

	clients := make([]*client, 3)
	for i := range clients {
		clients[i] = &client{
			tenantID: tid,
			topics:   make(map[Topic]struct{}),
			send:     make(chan Event, 32),
			closeCh:  make(chan struct{}),
		}
		h.subscribe(clients[i], TopicTables)
	}

	ev := Event{Topic: TopicTables, Action: "table.opened"}
	h.Broadcast(tid, ev)

	for i, c := range clients {
		select {
		case got := <-c.send:
			if got.Action != ev.Action {
				t.Errorf("client[%d] action = %q, want %q", i, got.Action, ev.Action)
			}
		default:
			t.Errorf("client[%d] did not receive event", i)
		}
	}
}

// ---------------------------------------------------------------------------
// subscribe / unsubscribeAll
// ---------------------------------------------------------------------------

func TestSubscribeUnsubscribe_RoundTrip(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}

	h.subscribe(c, TopicKitchen)
	h.subscribe(c, TopicOrders)

	h.mu.RLock()
	_, hasTenant := h.subs[tid]
	h.mu.RUnlock()
	if !hasTenant {
		t.Fatal("tenant bucket missing after subscribe")
	}

	h.unsubscribeAll(c)

	h.mu.RLock()
	_, hasTenant = h.subs[tid]
	h.mu.RUnlock()
	if hasTenant {
		t.Fatal("tenant bucket should be removed after unsubscribeAll when no subscribers remain")
	}
}

func TestUnsubscribeAll_NoOp_WhenNoBucket(t *testing.T) {
	h := newTestHub()
	c := &client{
		tenantID: uuid.New(),
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	// Must not panic.
	h.unsubscribeAll(c)
}

func TestSubscribe_MultipleTopics(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	topics := []Topic{TopicKitchen, TopicTables, TopicOrders, TopicFinance}
	for _, tp := range topics {
		h.subscribe(c, tp)
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	bucket := h.subs[tid]
	for _, tp := range topics {
		if _, ok := bucket[tp]; !ok {
			t.Errorf("topic %q not in bucket", tp)
		}
	}
}

// ---------------------------------------------------------------------------
// BroadcastAfterCommit
// ---------------------------------------------------------------------------

func TestBroadcastAfterCommit_NoRegistry_FiresImmediately(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	h.subscribe(c, TopicKitchen)

	ev := Event{Topic: TopicKitchen, Action: "order.item.sent"}
	// Plain context — no post-commit registry → fires immediately via AfterCommit fallback.
	h.BroadcastAfterCommit(context.Background(), tid, ev)

	select {
	case got := <-c.send:
		if got.Action != ev.Action {
			t.Errorf("action = %q, want %q", got.Action, ev.Action)
		}
	default:
		t.Fatal("BroadcastAfterCommit should fire immediately with no registry")
	}
}

func TestBroadcastAfterCommit_WithRegistry_DefersUntilRunPostCommit(t *testing.T) {
	h := newTestHub()
	tid := uuid.New()
	c := &client{
		tenantID: tid,
		topics:   make(map[Topic]struct{}),
		send:     make(chan Event, 32),
		closeCh:  make(chan struct{}),
	}
	h.subscribe(c, TopicOrders)

	ctx := appctx.WithPostCommit(context.Background())
	ev := Event{Topic: TopicOrders, Action: "order.opened"}
	h.BroadcastAfterCommit(ctx, tid, ev)

	// Should NOT have been delivered yet.
	select {
	case got := <-c.send:
		t.Fatalf("premature delivery before RunPostCommit: %+v", got)
	default:
		// correct
	}

	// Drain the registry.
	appctx.RunPostCommit(ctx)

	select {
	case got := <-c.send:
		if got.Action != ev.Action {
			t.Errorf("action = %q, want %q", got.Action, ev.Action)
		}
	default:
		t.Fatal("event not delivered after RunPostCommit")
	}
}

func TestBroadcastAfterCommit_WithRegistry_NoSubscribers_NoOp(t *testing.T) {
	h := newTestHub()
	ctx := appctx.WithPostCommit(context.Background())
	// No subscribers — must not panic.
	h.BroadcastAfterCommit(ctx, uuid.New(), Event{Topic: TopicFinance, Action: "shift.closed"})
	appctx.RunPostCommit(ctx) // drain
}

// ---------------------------------------------------------------------------
// Event JSON shape
// ---------------------------------------------------------------------------

func TestEvent_JSONShape(t *testing.T) {
	ev := Event{
		Topic:  TopicKitchen,
		Action: "order.item.sent",
		Ref:    map[string]any{"order_id": "abc-123", "item_id": "xyz-456"},
	}
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["topic"] != string(TopicKitchen) {
		t.Errorf("topic = %v, want %q", m["topic"], TopicKitchen)
	}
	if m["action"] != "order.item.sent" {
		t.Errorf("action = %v, want order.item.sent", m["action"])
	}
	ref, ok := m["ref"].(map[string]any)
	if !ok {
		t.Fatalf("ref is not a map: %T", m["ref"])
	}
	if ref["order_id"] != "abc-123" {
		t.Errorf("ref.order_id = %v", ref["order_id"])
	}
}

func TestEvent_JSONShape_OmitsRefWhenNil(t *testing.T) {
	ev := Event{Topic: TopicTables, Action: "table.closed"}
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["ref"]; ok {
		t.Error("ref field should be omitted when nil (omitempty)")
	}
}

// ---------------------------------------------------------------------------
// Topic constants
// ---------------------------------------------------------------------------

func TestTopicConstants(t *testing.T) {
	cases := []struct {
		topic Topic
		want  string
	}{
		{TopicKitchen, "kitchen"},
		{TopicTables, "tables"},
		{TopicOrders, "orders"},
		{TopicFinance, "finance"},
	}
	for _, tc := range cases {
		if string(tc.topic) != tc.want {
			t.Errorf("Topic = %q, want %q", tc.topic, tc.want)
		}
	}
}

// NOTE: The slow-client drop path (backpressure → disconnect) is not covered
// here because it requires a real *websocket.Conn. The disconnect() and
// runClient() lifecycle paths depend on the coder/websocket library's
// net.Conn-backed type, which cannot be safely faked at the unit level.
// That path is exercised by the existing integration test in
// internal/api/public_ws_test.go.
