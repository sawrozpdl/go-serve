// Package cbmstest is an httptest fake of IRD's CBMS bill posting API, for
// end-to-end tests of the real HTTP client and the outbox worker. It checks
// what the real server checks (credentials, required fields, the totals
// identity, BS date format), de-duplicates bills like the real server (101),
// and refuses a return whose bill it never received (105).
package cbmstest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"

	"github.com/pewssh/cafe-mgmt/api/internal/fiscal/cbms"
)

var (
	bsDateRe = regexp.MustCompile(`^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$`)
	fyRe     = regexp.MustCompile(`^[0-9]{4}\.[0-9]{3}$`)
)

// Server is a running fake CBMS.
type Server struct {
	*httptest.Server
	mu    sync.Mutex
	users map[string]string // username → password
	bills map[string]bool   // pan|fy|number
	// Requests counts posts per endpoint; Bodies keeps the last body seen.
	Requests map[string]int
	Bodies   []map[string]any
	// FailNext makes the next N requests answer HTTP 503 (transport failure).
	FailNext int
}

// New starts a fake accepting IRD's public test login (Test_CBMS / test@321).
func New() *Server {
	s := &Server{
		users:    map[string]string{"Test_CBMS": "test@321"},
		bills:    map[string]bool{},
		Requests: map[string]int{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/bill", func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, cbms.EndpointBill) })
	mux.HandleFunc("/api/billreturn", func(w http.ResponseWriter, r *http.Request) { s.handle(w, r, cbms.EndpointBillReturn) })
	s.Server = httptest.NewServer(mux)
	return s
}

// AddUser registers another login.
func (s *Server) AddUser(username, password string) {
	s.mu.Lock()
	s.users[username] = password
	s.mu.Unlock()
}

// HasBill reports whether a bill was stored.
func (s *Server) HasBill(pan, fy, number string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bills[pan+"|"+fy+"|"+number]
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request, ep cbms.Endpoint) {
	s.mu.Lock()
	s.Requests[string(ep)]++
	if s.FailNext > 0 {
		s.FailNext--
		s.mu.Unlock()
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()

	reply := func(code int) { _, _ = fmt.Fprint(w, code) }
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		reply(cbms.CodeInvalidModel)
		return
	}
	s.mu.Lock()
	s.Bodies = append(s.Bodies, body)
	s.mu.Unlock()

	str := func(k string) string { v, _ := body[k].(string); return v }
	s.mu.Lock()
	pw, ok := s.users[str("username")]
	s.mu.Unlock()
	if !ok || pw != str("password") || str("seller_pan") == "" {
		reply(cbms.CodeBadCredentials)
		return
	}
	if _, ok := body["isrealtime"].(bool); !ok || !fyRe.MatchString(str("fiscal_year")) {
		w.WriteHeader(http.StatusBadRequest)
		reply(cbms.CodeInvalidModel)
		return
	}
	raw, _ := json.Marshal(body)
	var sales cbms.Sales
	if err := json.Unmarshal(raw, &sales); err != nil || sales.Check() != nil {
		w.WriteHeader(http.StatusBadRequest)
		reply(cbms.CodeInvalidModel)
		return
	}

	pan, fy := str("seller_pan"), str("fiscal_year")
	switch ep {
	case cbms.EndpointBill:
		if str("invoice_number") == "" || !bsDateRe.MatchString(str("invoice_date")) {
			w.WriteHeader(http.StatusBadRequest)
			reply(cbms.CodeInvalidModel)
			return
		}
		key := pan + "|" + fy + "|" + str("invoice_number")
		s.mu.Lock()
		dup := s.bills[key]
		s.bills[key] = true
		s.mu.Unlock()
		if dup {
			reply(cbms.CodeDuplicate)
			return
		}
	case cbms.EndpointBillReturn:
		if str("credit_note_number") == "" || !bsDateRe.MatchString(str("credit_note_date")) || str("reason_for_return") == "" {
			w.WriteHeader(http.StatusBadRequest)
			reply(cbms.CodeInvalidModel)
			return
		}
		if !s.HasBill(pan, fy, str("ref_invoice_number")) {
			reply(cbms.CodeBillNotFound)
			return
		}
	}
	reply(cbms.CodeSuccess)
}
