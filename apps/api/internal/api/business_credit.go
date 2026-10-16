package api

// Credit across branches (decision 2026-10-16: "one view, pay where it's
// owed"). The same customer's credit accounts at different branches are
// linked by phone number, so an owner sees one combined balance per person
// and which branch each part is owed to. Nothing moves between branches:
// a debt is still settled at the branch it belongs to, so each branch's
// drawer and books stay right.
//
// Read-only, built on the fan-out: each branch's own ListHouseTabs runs as
// that branch (house_tab:read + its house_tabs feature), and the answers are
// grouped by phone. An account with no phone can't be linked safely — two
// "Ram"s at two branches are two people — so it stays on its own.

import (
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
)

var fanoutHouseTabs = fanoutRoute{perm: "house_tab:read", feature: billing.FeatureHouseTabs, handler: ListHouseTabs}

type houseTabsResp struct {
	HouseTabs []HouseTab `json:"house_tabs"`
}

// creditPhoneKey is the identity used to link accounts: digits only, with a
// Nepal country code dropped, so "+977 981-234-5678" and "9812345678" match.
// Empty when there is no usable number.
func creditPhoneKey(raw string) string {
	v := strings.TrimPrefix(normalizePhone(raw), "+")
	if strings.HasPrefix(v, "977") && len(v) > 10 {
		v = v[3:]
	}
	if len(v) < 6 {
		return ""
	}
	return v
}

// CreditAccount is one branch's account for a customer.
type CreditAccount struct {
	TenantID     uuid.UUID `json:"tenant_id"`
	BranchSlug   string    `json:"branch_slug"`
	BranchName   string    `json:"branch_name"`
	HouseTabID   uuid.UUID `json:"house_tab_id"`
	Name         string    `json:"name"`
	IsActive     bool      `json:"is_active"`
	BalanceCents int64     `json:"balance_cents"`
}

// CreditCustomer is one person across the branches they have credit at.
type CreditCustomer struct {
	Key          string          `json:"key"`
	Name         string          `json:"name"`
	Phone        string          `json:"phone"`
	Linked       bool            `json:"linked"` // matched by phone (else a single account)
	BalanceCents int64           `json:"balance_cents"`
	Accounts     []CreditAccount `json:"accounts"`
}

type businessCreditResp struct {
	Business  *BusinessInfo    `json:"business"`
	Branches  []BranchStatus   `json:"branches"`
	Complete  bool             `json:"complete"`
	Customers []CreditCustomer `json:"customers"`
	// What the business is owed in total, across every branch that answered.
	TotalOwedCents int64 `json:"total_owed_cents"`
}

// GetBusinessCredit — GET /v1/business/credit?phone=&branches=
//
// phone narrows to one customer — the counter's "does this person also owe
// at another branch?" check.
func GetBusinessCredit(pool *pgxpool.Pool, repo *rbac.Repo) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		biz, statuses, data, err := fanout[houseTabsResp](r, pool, repo, fanoutHouseTabs)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		complete, _ := fanoutMeta(statuses)
		resp := businessCreditResp{Business: biz, Branches: statuses, Complete: complete}
		resp.Customers = groupCredit(data, creditPhoneKey(r.URL.Query().Get("phone")))
		for _, c := range resp.Customers {
			resp.TotalOwedCents += c.BalanceCents
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// groupCredit links each branch's accounts by phone. Archived accounts with
// nothing owed are left out — they're history, not credit. With onlyKey set,
// only that customer is returned.
func groupCredit(data []BranchData[houseTabsResp], onlyKey string) []CreditCustomer {
	byKey := map[string]*CreditCustomer{}
	var order []string
	for _, d := range data {
		for _, t := range d.Data.HouseTabs {
			if !t.IsActive && t.BalanceCents == 0 {
				continue
			}
			key := creditPhoneKey(t.ContactPhone)
			linked := key != ""
			if !linked {
				key = "tab:" + t.ID.String()
			}
			if onlyKey != "" && key != onlyKey {
				continue
			}
			c, ok := byKey[key]
			if !ok {
				c = &CreditCustomer{Key: key, Name: t.Name, Phone: t.ContactPhone, Linked: linked, Accounts: []CreditAccount{}}
				byKey[key] = c
				order = append(order, key)
			}
			c.BalanceCents += t.BalanceCents
			c.Accounts = append(c.Accounts, CreditAccount{
				TenantID: d.TenantID, BranchSlug: d.Slug, BranchName: d.Name,
				HouseTabID: t.ID, Name: t.Name, IsActive: t.IsActive, BalanceCents: t.BalanceCents,
			})
		}
	}
	out := make([]CreditCustomer, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].BalanceCents != out[j].BalanceCents {
			return out[i].BalanceCents > out[j].BalanceCents
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}
