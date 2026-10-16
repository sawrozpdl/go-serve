package api

// The all-branches view. Each branch's figures come from the SAME handler the
// branch's own dashboard calls, run against that branch in its own read-only,
// RLS-scoped transaction, behind the same permission and plan gates its own
// request would face. Consolidation is then plain addition of those answers.
//
// That is the whole point of the design: no consolidated query re-derives a
// money figure, so the all-branches Sales can never disagree with the sum of
// the branches' own Sales — the money vocabulary (money.go) is reused, not
// re-implemented.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/errgroup"

	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/db"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

// Branch outcome codes in a fan-out response.
const (
	branchOK       = "ok"
	branchDenied   = "forbidden"             // no permission there
	branchUpgrade  = "plan_upgrade_required" // that branch's plan lacks the feature
	branchNotFound = "not_found"             // not a branch the caller can enter
	branchError    = "error"
)

// fanoutRoute is one report the all-branches view can consolidate, with the
// gates its per-branch route has in router.go.
type fanoutRoute struct {
	perm    string
	feature billing.FeatureKey // "" = not plan-gated
	handler http.HandlerFunc
}

var (
	fanoutDashboard   = fanoutRoute{perm: "report:read", handler: GetDashboard}
	fanoutCafeBalance = fanoutRoute{perm: "finance:read", handler: GetCafeBalance}
)

// BranchStatus reports how one branch fared in a fan-out.
type BranchStatus struct {
	TenantID  uuid.UUID `json:"tenant_id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Timezone  string    `json:"timezone"`
	Status    string    `json:"status"`
	ErrorCode string    `json:"error_code,omitempty"`
}

// BranchData is one branch's own answer.
type BranchData[T any] struct {
	TenantID uuid.UUID `json:"tenant_id"`
	Slug     string    `json:"slug"`
	Name     string    `json:"name"`
	Data     T         `json:"data"`
}

// FanoutResponse is what every /business/reports/* endpoint returns.
type FanoutResponse[T any] struct {
	Business *BusinessInfo   `json:"business"`
	Branches []BranchStatus  `json:"branches"`
	Complete bool            `json:"complete"` // every requested branch answered
	// Branches in different timezones have different "today"s; the totals
	// still add up, but a day-by-day chart lines up local days, not instants.
	MixedTimezones bool            `json:"mixed_timezones"`
	Totals         T               `json:"totals"`
	PerBranch      []BranchData[T] `json:"per_branch"`
}

// bufferWriter captures a handler's response in memory.
type bufferWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bufferWriter) Header() http.Header { return b.header }
func (b *bufferWriter) WriteHeader(code int) {
	if b.status == 0 {
		b.status = code
	}
}
func (b *bufferWriter) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}

// runInBranch runs route against one branch exactly as that branch's own
// request would: its membership, permissions and plan are loaded for it, and
// the handler runs in a fresh READ-ONLY tx scoped to it — a report that ever
// tried to write here fails loudly instead of writing into a sibling.
func runInBranch(base *http.Request, pool *pgxpool.Pool, repo *rbac.Repo, userID uuid.UUID, br Branch, route fanoutRoute) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(base.Context(), 10*time.Second)
	defer cancel()

	ctx = appctx.WithTenant(ctx, appctx.Tenant{ID: br.TenantID, Slug: br.Slug, Name: br.Name, Timezone: br.Timezone})
	mctx, err := auth.LoadMember(ctx, pool, repo, br.TenantID, userID)
	if errors.Is(err, auth.ErrNotMember) {
		return http.StatusForbidden, []byte(`{"code":"forbidden"}`), nil
	}
	if err != nil {
		return 0, nil, err
	}
	tx, err := db.BeginScopedTx(mctx, pool, br.TenantID, userID, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	rctx := appctx.WithPostCommit(appctx.WithTx(mctx, tx))
	req := base.Clone(rctx)
	bw := &bufferWriter{header: http.Header{}}

	var h http.Handler = route.handler
	if route.feature != "" {
		h = billing.RequireFeature(route.feature)(h)
	}
	h = auth.Require(route.perm)(h)
	h.ServeHTTP(bw, req)
	if bw.status == 0 {
		bw.status = http.StatusOK
	}
	return bw.status, bw.body.Bytes(), nil
}

// fanout runs route in each requested branch (at most four at a time) and
// decodes each answer into T.
func fanout[T any](r *http.Request, pool *pgxpool.Pool, repo *rbac.Repo, route fanoutRoute) (*BusinessInfo, []BranchStatus, []BranchData[T], error) {
	ctx := r.Context()
	biz, branches, err := loadMyBusiness(ctx, appctx.Tx(ctx))
	if err != nil {
		return nil, nil, nil, err
	}
	targets, statuses := selectBranches(branches, r.URL.Query().Get("branches"))
	user, _ := appctx.UserFromContext(ctx)

	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make([]result, len(targets))
	g := new(errgroup.Group)
	g.SetLimit(4)
	for i, br := range targets {
		g.Go(func() error {
			code, body, err := runInBranch(r, pool, repo, user.ID, br, route)
			results[i] = result{code, body, err}
			return nil
		})
	}
	_ = g.Wait()

	data := []BranchData[T]{}
	for i, br := range targets {
		st := BranchStatus{TenantID: br.TenantID, Slug: br.Slug, Name: br.Name, Timezone: br.Timezone}
		res := results[i]
		switch {
		case res.err != nil:
			st.Status = branchError
			appctx.Logger(ctx).WarnContext(ctx, "business.fanout_failed", "branch", br.Slug, "err", res.err.Error())
		case res.status == http.StatusForbidden:
			st.Status = branchDenied
			var env struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(res.body, &env)
			if env.Code == branchUpgrade {
				st.Status = branchUpgrade
			}
		case res.status >= 200 && res.status < 300:
			var v T
			if err := json.Unmarshal(res.body, &v); err != nil {
				st.Status = branchError
				break
			}
			st.Status = branchOK
			data = append(data, BranchData[T]{TenantID: br.TenantID, Slug: br.Slug, Name: br.Name, Data: v})
		default:
			st.Status = branchError
			st.ErrorCode = http.StatusText(res.status)
		}
		statuses = append(statuses, st)
	}
	return biz, statuses, data, nil
}

// selectBranches narrows the caller's branches to the ?branches= list (slugs
// or tenant ids, comma-separated; empty = all). A requested branch the caller
// cannot enter is reported as not_found — the same answer a branch that does
// not exist gets, so nothing leaks.
func selectBranches(all []Branch, raw string) ([]Branch, []BranchStatus) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return all, []BranchStatus{}
	}
	var out []Branch
	var missing []BranchStatus
	seen := map[uuid.UUID]bool{}
	for _, want := range strings.Split(raw, ",") {
		want = strings.TrimSpace(want)
		if want == "" {
			continue
		}
		found := false
		for _, b := range all {
			if b.Slug == want || b.TenantID.String() == want {
				found = true
				if !seen[b.TenantID] {
					seen[b.TenantID] = true
					out = append(out, b)
				}
				break
			}
		}
		if !found {
			missing = append(missing, BranchStatus{Slug: want, Status: branchNotFound})
		}
	}
	if missing == nil {
		missing = []BranchStatus{}
	}
	return out, missing
}

func fanoutMeta(statuses []BranchStatus) (complete, mixedTZ bool) {
	complete = true
	tz := ""
	for _, s := range statuses {
		if s.Status != branchOK {
			complete = false
			continue
		}
		if tz == "" {
			tz = s.Timezone
		} else if s.Timezone != tz {
			mixedTZ = true
		}
	}
	return complete, mixedTZ
}

// GetBusinessDashboard — GET /v1/business/reports/dashboard?branches=&range=&from=&to=
func GetBusinessDashboard(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		biz, statuses, data, err := fanout[ReportsDashboard](r, pool, repo, fanoutDashboard)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, mixed := fanoutMeta(statuses)
		parts := make([]ReportsDashboard, len(data))
		for i, d := range data {
			parts[i] = d.Data
		}
		writeJSON(w, http.StatusOK, FanoutResponse[ReportsDashboard]{
			Business: biz, Branches: statuses, Complete: complete, MixedTimezones: mixed,
			Totals: mergeDashboards(parts), PerBranch: data,
		})
	}
}

// GetBusinessCafeBalance — GET /v1/business/reports/cafe-balance?branches=
func GetBusinessCafeBalance(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		biz, statuses, data, err := fanout[CafeBalance](r, pool, repo, fanoutCafeBalance)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, mixed := fanoutMeta(statuses)
		parts := make([]CafeBalance, len(data))
		for i, d := range data {
			parts[i] = d.Data
		}
		writeJSON(w, http.StatusOK, FanoutResponse[CafeBalance]{
			Business: biz, Branches: statuses, Complete: complete, MixedTimezones: mixed,
			Totals: mergeCafeBalances(parts), PerBranch: data,
		})
	}
}

// mergeDashboards adds branch dashboards together.
//
// Every money and count field is a plain sum. Average ticket is recomputed
// from the summed figures with GetDashboard's own formula — averaging the
// branches' averages would weight a quiet branch like a busy one. The daily
// series is summed per local day.
//
// Deliberately left EMPTY in the totals:
//   - top sellers / slow movers: each branch sends only its top N, so a merged
//     list could rank an item that is 6th everywhere below one that is 5th in
//     one branch. A ranking that may be wrong is worse than none here.
//   - tab and credit breakdowns: credit customers belong to a branch; two
//     "Ram"s at two branches are two people. They stay in per_branch.
func mergeDashboards(parts []ReportsDashboard) ReportsDashboard {
	out := ReportsDashboard{
		Daily:                    []DailyPoint{},
		TopSellers:               []TopItem{},
		SlowMovers:               []TopItem{},
		TabBreakdown:             []TabBreakdownRow{},
		CreditCollectedBreakdown: []CreditCollectedRow{},
	}
	if len(parts) == 0 {
		return out
	}
	first := parts[0]
	out.Range, out.From, out.To, out.Timezone = first.Range, first.From, first.To, first.Timezone
	out.DailyFrom, out.DailyTo, out.DailyPadded = first.DailyFrom, first.DailyTo, first.DailyPadded

	daily := map[string]int64{}
	for _, p := range parts {
		k := p.KPIs
		out.KPIs.SalesCents += k.SalesCents
		out.KPIs.TabCents += k.TabCents
		out.KPIs.CreditCollectedCents += k.CreditCollectedCents
		out.KPIs.TaxCents += k.TaxCents
		out.KPIs.ServiceCents += k.ServiceCents
		out.KPIs.OrderCount += k.OrderCount
		out.KPIs.ExpensesCents += k.ExpensesCents
		out.KPIs.NetCents += k.NetCents
		out.KPIs.VoidCount += k.VoidCount
		out.KPIs.DiscountCents += k.DiscountCents
		out.PaymentMix.CashCents += p.PaymentMix.CashCents
		out.PaymentMix.BankCents += p.PaymentMix.BankCents
		out.PaymentMix.OnlineCents += p.PaymentMix.OnlineCents
		for _, d := range p.Daily {
			daily[d.Day] += d.SalesCents
		}
		if p.DailyFrom.Before(out.DailyFrom) {
			out.DailyFrom = p.DailyFrom
		}
		if p.DailyTo.After(out.DailyTo) {
			out.DailyTo = p.DailyTo
		}
		out.DailyPadded = out.DailyPadded || p.DailyPadded
	}
	if out.KPIs.OrderCount > 0 {
		out.KPIs.AvgTicketCents = out.KPIs.SalesCents / int64(out.KPIs.OrderCount)
	}
	for day, cents := range daily {
		out.Daily = append(out.Daily, DailyPoint{Day: day, SalesCents: cents})
	}
	sort.Slice(out.Daily, func(i, j int) bool { return out.Daily[i].Day < out.Daily[j].Day })
	return out
}

// mergeCafeBalances adds branch balances together. Channels are summed per
// account method. The drawer source is kept only when every branch agrees
// ("live" everywhere); otherwise it is "mixed" and the per-branch rows say
// which drawer is live and which is a last-close figure.
func mergeCafeBalances(parts []CafeBalance) CafeBalance {
	out := CafeBalance{Channels: []AccountBalance{}, DrawerSource: "none"}
	byMethod := map[string]*AccountBalance{}
	var order []string
	for i, p := range parts {
		out.DrawerCents += p.DrawerCents
		out.BankCents += p.BankCents
		out.OwnerCashCents += p.OwnerCashCents
		out.TotalCents += p.TotalCents
		out.Outstanding.LoansCents += p.Outstanding.LoansCents
		switch {
		case i == 0:
			out.DrawerSource = p.DrawerSource
		case out.DrawerSource != p.DrawerSource:
			out.DrawerSource = "mixed"
		}
		for _, c := range p.Channels {
			acc, ok := byMethod[c.Method]
			if !ok {
				cp := AccountBalance{Method: c.Method, Label: c.Label}
				acc = &cp
				byMethod[c.Method] = acc
				order = append(order, c.Method)
			}
			acc.BalanceCents += c.BalanceCents
			acc.PaymentsCents += c.PaymentsCents
			acc.CreditCollectedCents += c.CreditCollectedCents
			acc.ExpensesCents += c.ExpensesCents
			acc.TransfersInCents += c.TransfersInCents
			acc.TransfersOutCents += c.TransfersOutCents
			acc.OtherMovementsCents += c.OtherMovementsCents
		}
	}
	for _, m := range order {
		out.Channels = append(out.Channels, *byMethod[m])
	}
	return out
}
