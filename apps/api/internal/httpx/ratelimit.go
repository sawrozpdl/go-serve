package httpx

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// rateLimiter is a minimal in-memory sliding-window IP rate limiter.
//
// Suitable for single-instance deployments. For multi-region / multi-replica
// rollouts swap this for a Redis-backed cell (token bucket against a shared
// counter). The math stays the same; only the store changes.
//
// Tradeoffs:
//   - Lock per-IP for the duration of the slice trim — fine for V1 traffic
//     levels (sub-millisecond at <50k req/min on a beefy node), revisit if
//     the lock shows up on a flamegraph.
//   - Bounded memory: a background sweeper drops idle IPs every 5 minutes.
type rateLimiter struct {
	limit   int           // max events per window
	window  time.Duration // sliding window length
	mu      sync.Mutex
	buckets map[string][]time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		limit:   limit,
		window:  window,
		buckets: make(map[string][]time.Time),
	}
	go rl.sweep()
	return rl
}

// allow returns (ok, remaining, retryAfter). ok=false means the caller
// should reject with 429. retryAfter is the seconds until the oldest event
// inside the window drops off.
func (rl *rateLimiter) allow(key string) (bool, int, int) {
	if rl == nil || rl.limit <= 0 {
		return true, rl.limit, 0
	}
	now := time.Now()
	cutoff := now.Add(-rl.window)

	rl.mu.Lock()
	defer rl.mu.Unlock()

	events := rl.buckets[key]
	// Trim events outside the window.
	i := 0
	for ; i < len(events); i++ {
		if events[i].After(cutoff) {
			break
		}
	}
	if i > 0 {
		events = events[i:]
	}

	if len(events) >= rl.limit {
		// Oldest event determines retry-after.
		retry := int(rl.window.Seconds() - now.Sub(events[0]).Seconds())
		if retry < 1 {
			retry = 1
		}
		rl.buckets[key] = events
		return false, 0, retry
	}

	events = append(events, now)
	rl.buckets[key] = events
	return true, rl.limit - len(events), 0
}

func (rl *rateLimiter) sweep() {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for range tick.C {
		rl.mu.Lock()
		cutoff := time.Now().Add(-rl.window)
		for k, evts := range rl.buckets {
			if len(evts) == 0 || evts[len(evts)-1].Before(cutoff) {
				delete(rl.buckets, k)
			}
		}
		rl.mu.Unlock()
	}
}

// RateLimitByIP returns chi middleware that allows `limit` requests per IP
// per `window`. Trusts chi's RealIP middleware to have set RemoteAddr from
// X-Forwarded-For when running behind a proxy.
func RateLimitByIP(limit int, window time.Duration) func(http.Handler) http.Handler {
	rl := newRateLimiter(limit, window)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			ok, remaining, retry := rl.allow(ip)
			if !ok {
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"code":"rate_limited","message":"too many requests, please slow down"}`))
				return
			}
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
			next.ServeHTTP(w, r)
		})
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
