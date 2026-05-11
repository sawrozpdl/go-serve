package httpx

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/api"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/config"
	"github.com/pewssh/cafe-mgmt/api/internal/db"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

func NewRouter(cfg config.Config, logger *slog.Logger, pool *pgxpool.Pool, hub *realtime.Hub, store storage.Storage) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(slogRequest(logger))
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Tenant-ID", "X-Requested-With"},
		ExposedHeaders:   []string{"X-Request-ID"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/healthz", healthz)
	r.Get("/readyz", healthz)

	// Static uploads — public read; writes go through /v1/tenant/logo.
	// Only mounted for the local-disk storage driver. With STORAGE_DRIVER=s3
	// the SPA fetches uploaded objects directly from the S3-compatible
	// origin (e.g., Supabase Storage), so the API doesn't serve files.
	if cfg.Storage.Driver == "local" {
		r.Get("/uploads/*", http.StripPrefix(cfg.Storage.LocalPublicBase, http.FileServer(http.Dir(cfg.Storage.LocalRoot))).ServeHTTP)
	}

	// WebSocket endpoint — auth via session cookie + ?tenant= query.
	// Lives outside /v1 because the upgrade can't go through the
	// transaction middleware.
	r.Get("/ws", realtime.Handler(pool, hub, cfg.CORSOrigins))

	// Auth routes — no tenant required.
	r.Route("/auth", func(r chi.Router) {
		googleEnabled := cfg.Google.IsConfigured()
		devLoginEnabled := cfg.IsDev()

		// /auth/config tells the unauthenticated SPA which login methods are
		// available so it can render the matching buttons.
		r.Get("/config", auth.ConfigHandler(googleEnabled, devLoginEnabled))

		// Google OIDC if configured.
		if g, err := auth.NewGoogle(context.Background(), cfg.Google, pool, cfg.RootDomain, cfg.SecureCookies, cfg.PostLoginRedirectURL); err == nil && g != nil {
			r.Get("/google", g.Start)
			r.Get("/google/callback", g.Callback)
		}
		r.Post("/logout", auth.LogoutHandler(pool, cfg.RootDomain, cfg.SecureCookies))

		// Dev-only login bypass.
		if devLoginEnabled {
			r.Post("/dev-login", auth.DevLoginHandler(pool, cfg.RootDomain, cfg.SecureCookies))
		}
	})

	// /v1 surface. Each route group resolves its own context (tenant or no
	// tenant) BEFORE TxMiddleware so the tx is begun with the right
	// app.tenant_id / app.user_id values for RLS.
	r.Route("/v1", func(r chi.Router) {
		r.Use(auth.SessionMiddleware(pool))

		r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{
				"service": "goserve-api",
				"env":     cfg.Env,
			})
		})

		// Identity routes — session required, tenant optional (may be
		// pre-pick), tx wraps so /me can join tenant_members.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(tenant.OptionalMiddleware(pool, cfg.RootDomain))
			r.Use(db.TxMiddleware(pool))
			r.Get("/me", api.Me)
			r.Post("/sessions/select-tenant", api.SelectTenant(pool))
			// Onboarding: an authenticated user (with no memberships yet, or
			// just adding another cafe) creates a workspace and becomes its
			// owner. Mounted here because no tenant context exists yet.
			r.Post("/tenants", api.CreateTenant)
		})

		// Setting one's own approval PIN — requires tenant + member
		// because role is enforced (only owner|manager can hold a PIN).
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(tenant.Middleware(pool, cfg.RootDomain))
			r.Use(auth.RequireMember(pool))
			r.Use(db.TxMiddleware(pool))
			r.Post("/me/pin", api.SetMyPIN)
		})

		// Tenant-scoped routes — must be an active member of the
		// resolved tenant; tx is begun with the tenant + user contexts set.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(tenant.Middleware(pool, cfg.RootDomain))
			r.Use(auth.RequireMember(pool))
			r.Use(db.TxMiddleware(pool))

			r.Route("/menu/categories", func(r chi.Router) {
				r.Get("/", api.ListMenuCategories)
				r.Post("/", api.CreateMenuCategory)
				r.Patch("/{id}", api.UpdateMenuCategory)
				r.Delete("/{id}", api.DeleteMenuCategory)
			})
			r.Route("/menu/items", func(r chi.Router) {
				r.Get("/", api.ListMenuItems)
				r.Post("/", api.CreateMenuItem)
				r.Patch("/{id}", api.UpdateMenuItem)
				r.Delete("/{id}", api.DeleteMenuItem)
			})
			r.Route("/members", func(r chi.Router) {
				r.Get("/", api.ListMembers)
				r.Patch("/{userId}/roles", api.UpdateMemberRoles)
			})
			r.Route("/invites", func(r chi.Router) {
				r.Get("/", api.ListInvites)
				r.Post("/", api.CreateInvite)
				r.Delete("/{id}", api.RevokeInvite)
			})
			r.Route("/tables", func(r chi.Router) {
				r.Get("/", api.ListServiceTables)
				r.Post("/", api.CreateServiceTable)
				r.Patch("/{id}", api.UpdateServiceTable)
				r.Delete("/{id}", api.DeleteServiceTable)
			})
			r.Route("/orders", func(r chi.Router) {
				r.Get("/", api.ListOrders)
				r.Post("/", api.OpenOrder(hub))
				r.Get("/{id}", api.GetOrder)
				r.Post("/{id}/items", api.AddOrderItems(hub))
				r.Patch("/{id}/items/{itemId}", api.UpdateOrderItem)
				r.Post("/{id}/items/{itemId}/void", api.VoidOrderItem(hub))
				r.Post("/{id}/send-to-kitchen", api.SendOrderToKitchen(hub))
				r.Post("/{id}/cancel", api.CancelOrder(hub))

				// Payments + close (M5).
				r.Get("/{id}/quote", api.GetSettleQuote)
				r.Get("/{id}/payments", api.ListOrderPayments)
				r.Post("/{id}/payments", api.RecordPayment(hub))
				r.Delete("/{id}/payments/{paymentId}", api.DeletePayment(hub))
				r.Post("/{id}/close", api.CloseOrder(hub))

				// Discounts + adjustments (M11).
				r.Get("/{id}/adjustments", api.ListOrderAdjustments)
				r.Post("/{id}/adjustments", api.ApplyOrderAdjustment(hub))
				r.Delete("/{id}/adjustments/{adjId}", api.RemoveOrderAdjustment(hub))
			})
			r.Route("/kitchen", func(r chi.Router) {
				r.Get("/tickets", api.ListKitchenTickets)
				r.Patch("/tickets/{itemId}", api.UpdateKitchenTicket(hub))
			})

			// Inventory (M6).
			r.Route("/inventory", func(r chi.Router) {
				r.Get("/", api.ListInventoryItems)
				r.Post("/", api.CreateInventoryItem)
				r.Patch("/{id}", api.UpdateInventoryItem)
				r.Delete("/{id}", api.DeleteInventoryItem)
				r.Get("/{id}/movements", api.ListInventoryMovements)
				r.Post("/{id}/adjust", api.AdjustInventory)
				r.Get("/{id}/pack-rules", api.ListPackRules)
				r.Post("/{id}/pack-rules", api.CreatePackRule)
				r.Delete("/{id}/pack-rules/{ruleId}", api.DeletePackRule)
			})
			r.Route("/menu/items/{id}/inventory-link", func(r chi.Router) {
				r.Get("/", api.GetMenuItemLink)
				r.Put("/", api.PutMenuItemLink)
			})

			// Expenses + cost-center allocations (M7).
			r.Route("/expense-categories", func(r chi.Router) {
				r.Get("/", api.ListExpenseCategories)
				r.Post("/", api.CreateExpenseCategory)
				r.Patch("/{id}", api.UpdateExpenseCategory)
				r.Delete("/{id}", api.DeleteExpenseCategory)
			})
			r.Route("/expenses", func(r chi.Router) {
				r.Get("/", api.ListExpenses)
				r.Post("/", api.CreateExpense)
				r.Get("/{id}", api.GetExpense)
				r.Delete("/{id}", api.DeleteExpense)
			})

			// Shifts / cash drawer (M10) + per-shift drawer ledger (0009).
			r.Route("/shifts", func(r chi.Router) {
				r.Get("/", api.ListShifts)
				r.Get("/current", api.GetCurrentShift)
				r.Post("/open", api.OpenShift)
				r.Post("/{id}/close", api.CloseShift)
				r.Get("/{id}/cash-drops", api.ListCashDrops)
				r.Post("/{id}/cash-drops", api.CreateCashDrop)
				r.Delete("/{id}/cash-drops/{dropId}", api.DeleteCashDrop)
			})

			// Account balances + inter-account transfers (0009).
			r.Route("/accounts", func(r chi.Router) {
				r.Get("/balances", api.GetAccountBalances)
			})
			r.Route("/transfers", func(r chi.Router) {
				r.Get("/", api.ListTransfers)
				r.Post("/", api.CreateTransfer)
				r.Delete("/{id}", api.DeleteTransfer)
			})

			// Tenant settings + branding (M12) — owner only on writes.
			r.Get("/tenant", api.GetTenant)
			r.Patch("/tenant", api.UpdateTenant)
			r.Post("/tenant/logo", api.UploadLogo(store))

			// House tabs (stakeholder running ledgers).
			r.Route("/house-tabs", func(r chi.Router) {
				r.Get("/", api.ListHouseTabs)
				r.Post("/", api.CreateHouseTab)
				r.Get("/{id}", api.GetHouseTab)
				r.Patch("/{id}", api.UpdateHouseTab)
				r.Delete("/{id}", api.DeleteHouseTab)
				r.Post("/{id}/settlements", api.CreateHouseTabSettlement)
			})

			// Audit log (M-audit) — owner/manager only enforced in handler.
			r.Route("/audit", func(r chi.Router) {
				r.Get("/", api.ListAuditEvents)
				r.Get("/actors", api.ListAuditActors)
			})

			// Reports (M8 + M9).
			r.Route("/reports", func(r chi.Router) {
				r.Get("/dashboard", api.GetDashboard)
				r.Get("/sales", api.GetSales)
				r.Get("/profitability", api.GetProfitability)
				r.Get("/profitability/{categoryId}", api.GetProfitabilityDrilldown)
			})
		})
	})

	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// slogRequest builds a per-request logger pre-tagged with req_id/method/path,
// stashes it on the request context (via appctx) so handlers can grab it
// with appctx.Logger(ctx), and emits one summary record at the end of the
// request. The summary is enriched with tenant/user once they're resolved
// downstream by the auth/tenant middlewares.
//
// Levels:
//   - 5xx → Error
//   - 4xx → Warn
//   - everything else → Info
func slogRequest(base *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			reqID := middleware.GetReqID(r.Context())

			rl := base.With(
				"req_id", reqID,
				"method", r.Method,
				"path", r.URL.Path,
			)
			ctx := appctx.WithLogger(r.Context(), rl)
			// Stash req-id + originating IP so deeper layers (audit log)
			// can read them without taking *http.Request.
			ctx = appctx.WithRequestID(ctx, reqID)
			ctx = appctx.WithIP(ctx, r.RemoteAddr)
			r = r.WithContext(ctx)

			rl.DebugContext(ctx, "http.request.start",
				"remote", r.RemoteAddr,
				"ua", r.UserAgent(),
			)

			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)

			// re-fetch ctx — handlers and downstream middleware may have
			// added tenant/user to it.
			ctx = r.Context()
			args := []any{
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"dur_ms", time.Since(start).Milliseconds(),
			}
			if t, ok := appctx.TenantFromContext(ctx); ok {
				args = append(args, "tenant", t.Slug)
			}
			if u, ok := appctx.UserFromContext(ctx); ok {
				args = append(args, "user", u.Email)
			}

			switch {
			case ww.Status() >= 500:
				rl.ErrorContext(ctx, "http.request", args...)
			case ww.Status() >= 400:
				rl.WarnContext(ctx, "http.request", args...)
			default:
				rl.InfoContext(ctx, "http.request", args...)
			}
		})
	}
}
