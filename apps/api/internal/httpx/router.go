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
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

func NewRouter(cfg config.Config, logger *slog.Logger, pool *pgxpool.Pool, hub *realtime.Hub, store storage.Storage, mailer *mail.Mailer) http.Handler {
	rbacRepo := rbac.NewRepo(pool, rbac.NewCache(4096))
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(slogRequest(logger))
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(SecurityHeaders(cfg.Env == "prod"))
	// Global throttle: 600 requests / IP / minute (10 rps sustained, with a
	// generous burst). Tightened on /auth/* below.
	r.Use(RateLimitByIP(600, time.Minute))

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
		// Per-IP throttle dedicated to /auth/*: 30 requests/min. Layered on
		// top of the global limit so a single host can't grind on login.
		// OTP-request still applies its own per-email cooldown + per-IP
		// hourly cap (otp.go) — this is the outer envelope.
		r.Use(RateLimitByIP(30, time.Minute))
		googleEnabled := cfg.Google.IsConfigured()
		devLoginEnabled := cfg.IsDev()
		// Email-OTP needs a working mailer in prod. In dev we still mount
		// the routes and log codes to the server console, so the SPA can
		// exercise the full flow without SendGrid creds.
		emailOtpEnabled := mailer != nil || cfg.IsDev()

		// /auth/config tells the unauthenticated SPA which login methods are
		// available so it can render the matching buttons.
		r.Get("/config", auth.ConfigHandler(googleEnabled, devLoginEnabled, emailOtpEnabled))

		// Google OIDC if configured.
		if g, err := auth.NewGoogle(context.Background(), cfg.Google, pool, cfg.RootDomain, cfg.SecureCookies, cfg.PostLoginRedirectURL); err == nil && g != nil {
			r.Get("/google", g.Start)
			r.Get("/google/callback", g.Callback)
		}
		r.Post("/logout", auth.LogoutHandler(pool, cfg.RootDomain, cfg.SecureCookies))

		// Email-OTP login — the alternative to Google for users without a
		// signed-in Google account on the device.
		otpParams := auth.OTPParams{
			CodeLength:     cfg.OTP.CodeLength,
			TTLSeconds:     cfg.OTP.TTLSeconds,
			ResendCooldown: cfg.OTP.ResendCooldown,
			MaxAttempts:    cfg.OTP.MaxAttempts,
			IPHourlyCap:    cfg.OTP.IPHourlyCap,
		}
		r.Post("/request-otp", auth.RequestOTPHandler(pool, mailer, otpParams, cfg.IsDev()))
		r.Post("/verify-otp", auth.VerifyOTPHandler(pool, otpParams, cfg.RootDomain, cfg.SecureCookies))

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
			r.Get("/me", api.Me(rbacRepo))
			r.Post("/sessions/select-tenant", api.SelectTenant(pool))
			// Onboarding: an authenticated user (with no memberships yet, or
			// just adding another cafe) creates a workspace and becomes its
			// owner. Mounted here because no tenant context exists yet.
			r.Post("/tenants", api.CreateTenant(rbacRepo))
			// GDPR endpoints — operate on the authenticated user across all
			// their workspaces. Tenant context is optional here because the
			// operations are identity-scoped, not workspace-scoped.
			r.Get("/me/export", api.ExportMyData)
			r.Delete("/me", api.DeleteMyAccount(pool))
		})

		// Tenant-scoped routes — must be an active member of the
		// resolved tenant; tx is begun with the tenant + user contexts set.
		// Every route declares its required permission via auth.Require(...);
		// the gate is enforced after RequireMember loads the permission set.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(tenant.Middleware(pool, cfg.RootDomain))
			r.Use(auth.RequireMember(pool, rbacRepo))
			r.Use(db.TxMiddleware(pool))

			r.Route("/menu/categories", func(r chi.Router) {
				r.With(auth.Require("menu:read")).Get("/", api.ListMenuCategories)
				r.With(auth.Require("menu:create")).Post("/", api.CreateMenuCategory)
				r.With(auth.Require("menu:update")).Patch("/{id}", api.UpdateMenuCategory)
				r.With(auth.Require("menu:delete")).Delete("/{id}", api.DeleteMenuCategory)
			})
			r.Route("/menu/items", func(r chi.Router) {
				r.With(auth.Require("menu:read")).Get("/", api.ListMenuItems)
				r.With(auth.Require("menu:create")).Post("/", api.CreateMenuItem)
				r.With(auth.Require("menu:update")).Patch("/{id}", api.UpdateMenuItem)
				r.With(auth.Require("menu:delete")).Delete("/{id}", api.DeleteMenuItem)
			})
			r.With(auth.Require("menu:read")).Get("/menu/popular", api.ListPopularMenuItems)

			r.Route("/members", func(r chi.Router) {
				r.With(auth.Require("member:read")).Get("/", api.ListMembers)
				r.With(auth.Require("member:update_role")).Patch("/{userId}/roles", api.UpdateMemberRoles(rbacRepo))
				r.With(auth.Require("member:delete")).Delete("/{userId}", api.RemoveMember)
			})
			r.Route("/invites", func(r chi.Router) {
				r.With(auth.Require("invite:read")).Get("/", api.ListInvites)
				r.With(auth.Require("invite:create")).Post("/", api.CreateInvite)
				r.With(auth.Require("invite:delete")).Delete("/{id}", api.RevokeInvite)
			})
			r.Route("/tables", func(r chi.Router) {
				r.With(auth.Require("table:read")).Get("/", api.ListServiceTables)
				r.With(auth.Require("table:create")).Post("/", api.CreateServiceTable)
				r.With(auth.Require("table:update")).Patch("/{id}", api.UpdateServiceTable)
				r.With(auth.Require("table:delete")).Delete("/{id}", api.DeleteServiceTable)
			})
			r.Route("/orders", func(r chi.Router) {
				r.With(auth.Require("order:read")).Get("/", api.ListOrders)
				r.With(auth.Require("order:create")).Post("/", api.OpenOrder(hub))
				r.With(auth.Require("order:read")).Get("/{id}", api.GetOrder)
				r.With(auth.Require("order:add_items")).Post("/{id}/items", api.AddOrderItems(hub))
				r.With(auth.Require("order:update_item")).Patch("/{id}/items/{itemId}", api.UpdateOrderItem)
				r.With(auth.Require("order:void_item")).Post("/{id}/items/{itemId}/void", api.VoidOrderItem(hub))
				r.With(auth.Require("order:send_kitchen")).Post("/{id}/send-to-kitchen", api.SendOrderToKitchen(hub))
				r.With(auth.Require("order:cancel")).Post("/{id}/cancel", api.CancelOrder(hub))

				// Payments + close (M5).
				r.With(auth.Require("order:read")).Get("/{id}/quote", api.GetSettleQuote)
				r.With(auth.Require("payment:read")).Get("/{id}/payments", api.ListOrderPayments)
				r.With(auth.Require("payment:record")).Post("/{id}/payments", api.RecordPayment(hub))
				r.With(auth.Require("payment:delete")).Delete("/{id}/payments/{paymentId}", api.DeletePayment(hub))
				r.With(auth.Require("order:settle")).Post("/{id}/close", api.CloseOrder(hub))

				// Discounts + adjustments (M11).
				r.With(auth.Require("adjustment:read")).Get("/{id}/adjustments", api.ListOrderAdjustments)
				r.With(auth.Require("adjustment:apply")).Post("/{id}/adjustments", api.ApplyOrderAdjustment(hub))
				r.With(auth.Require("adjustment:delete")).Delete("/{id}/adjustments/{adjId}", api.RemoveOrderAdjustment(hub))
			})
			r.Route("/kitchen", func(r chi.Router) {
				r.With(auth.Require("kitchen:read")).Get("/tickets", api.ListKitchenTickets)
				r.With(auth.Require("kitchen:update")).Patch("/tickets/{itemId}", api.UpdateKitchenTicket(hub))
			})

			// Inventory (M6).
			r.Route("/inventory", func(r chi.Router) {
				r.With(auth.Require("inventory:read")).Get("/", api.ListInventoryItems)
				r.With(auth.Require("inventory:create")).Post("/", api.CreateInventoryItem)
				r.With(auth.Require("inventory:update")).Patch("/{id}", api.UpdateInventoryItem)
				r.With(auth.Require("inventory:delete")).Delete("/{id}", api.DeleteInventoryItem)
				r.With(auth.Require("inventory:read")).Get("/{id}/movements", api.ListInventoryMovements)
				r.With(auth.Require("inventory:adjust")).Post("/{id}/adjust", api.AdjustInventory)
				r.With(auth.Require("inventory:read")).Get("/{id}/pack-rules", api.ListPackRules)
				r.With(auth.Require("inventory:create")).Post("/{id}/pack-rules", api.CreatePackRule)
				r.With(auth.Require("inventory:delete")).Delete("/{id}/pack-rules/{ruleId}", api.DeletePackRule)
			})
			r.Route("/menu/items/{id}/inventory-link", func(r chi.Router) {
				r.With(auth.Require("menu:read")).Get("/", api.GetMenuItemLink)
				r.With(auth.Require("menu:update")).Put("/", api.PutMenuItemLink)
			})

			// Expenses + cost-center allocations (M7).
			r.Route("/expense-categories", func(r chi.Router) {
				r.With(auth.Require("expense:read")).Get("/", api.ListExpenseCategories)
				r.With(auth.Require("expense:create")).Post("/", api.CreateExpenseCategory)
				r.With(auth.Require("expense:update")).Patch("/{id}", api.UpdateExpenseCategory)
				r.With(auth.Require("expense:delete")).Delete("/{id}", api.DeleteExpenseCategory)
			})
			r.Route("/expenses", func(r chi.Router) {
				r.With(auth.Require("expense:read")).Get("/", api.ListExpenses)
				r.With(auth.Require("expense:create")).Post("/", api.CreateExpense)
				r.With(auth.Require("expense:read")).Get("/{id}", api.GetExpense)
				r.With(auth.Require("expense:delete")).Delete("/{id}", api.DeleteExpense)
			})

			// Shifts / cash drawer (M10) + per-shift drawer ledger (0009).
			r.Route("/shifts", func(r chi.Router) {
				r.With(auth.Require("shift:read")).Get("/", api.ListShifts)
				r.With(auth.Require("shift:read")).Get("/current", api.GetCurrentShift)
				r.With(auth.Require("shift:create")).Post("/open", api.OpenShift)
				r.With(auth.Require("shift:settle")).Post("/{id}/close", api.CloseShift(mailer))
				r.With(auth.Require("shift:read")).Get("/{id}/cash-drops", api.ListCashDrops)
				r.With(auth.Require("shift:withdraw")).Post("/{id}/cash-drops", api.CreateCashDrop)
				r.With(auth.Require("shift:delete")).Delete("/{id}/cash-drops/{dropId}", api.DeleteCashDrop)
			})

			// Account balances + inter-account transfers (0009).
			r.Route("/accounts", func(r chi.Router) {
				r.With(auth.Require("account:read")).Get("/balances", api.GetAccountBalances)
			})
			r.Route("/transfers", func(r chi.Router) {
				r.With(auth.Require("transfer:read")).Get("/", api.ListTransfers)
				r.With(auth.Require("transfer:create")).Post("/", api.CreateTransfer)
				r.With(auth.Require("transfer:delete")).Delete("/{id}", api.DeleteTransfer)
			})

			// Cafe finance: owners, owner ledger, cafe balance (0014).
			// Finance is owner-only by default; system owner holds *:* so it
			// passes the granular gates too.
			r.Route("/finance", func(r chi.Router) {
				r.With(auth.Require("finance:read")).Get("/cafe-balance", api.GetCafeBalance)
				r.With(auth.Require("finance:read")).Get("/cafe-summary", api.GetCafeSummary)
				r.With(auth.Require("finance:read")).Get("/owners", api.ListCafeOwners)
				r.With(auth.Require("finance:create_owner")).Post("/owners", api.CreateCafeOwner(hub))
				r.With(auth.Require("finance:update_owner")).Patch("/owners/{id}", api.UpdateCafeOwner(hub))
				r.With(auth.Require("finance:delete_owner")).Post("/owners/{id}/deactivate", api.DeactivateCafeOwner(hub))
				r.With(auth.Require("finance:read")).Get("/owner-ledger", api.ListOwnerLedger)
				r.With(auth.Require("finance:correct")).Post("/owner-ledger/{id}/correct", api.CorrectOwnerLedger(hub))
				r.With(auth.Require("finance:invest")).Post("/investments", api.CreateInvestment(hub))
				r.With(auth.Require("finance:payout")).Post("/payouts", api.CreatePayouts(hub))
				r.With(auth.Require("finance:repay")).Post("/loans/{id}/repay", api.RepayLoan(hub))
			})

			// Tenant settings + branding (M12).
			r.With(auth.Require("tenant:read")).Get("/tenant", api.GetTenant)
			r.With(auth.Require("tenant:update")).Patch("/tenant", api.UpdateTenant)
			r.With(auth.Require("tenant:upload_logo")).Post("/tenant/logo", api.UploadLogo(store))

			// House tabs (stakeholder running ledgers).
			r.Route("/house-tabs", func(r chi.Router) {
				r.With(auth.Require("house_tab:read")).Get("/", api.ListHouseTabs)
				r.With(auth.Require("house_tab:create")).Post("/", api.CreateHouseTab)
				r.With(auth.Require("house_tab:read")).Get("/{id}", api.GetHouseTab)
				r.With(auth.Require("house_tab:update")).Patch("/{id}", api.UpdateHouseTab)
				r.With(auth.Require("house_tab:delete")).Delete("/{id}", api.DeleteHouseTab)
				r.With(auth.Require("house_tab:settle")).Post("/{id}/settlements", api.CreateHouseTabSettlement)
			})

			// Audit log.
			r.Route("/audit", func(r chi.Router) {
				r.With(auth.Require("audit:read")).Get("/", api.ListAuditEvents)
				r.With(auth.Require("audit:read")).Get("/actors", api.ListAuditActors)
			})

			// Reports (M8 + M9 + analytics expansion).
			r.Route("/reports", func(r chi.Router) {
				r.With(auth.Require("report:read")).Get("/dashboard", api.GetDashboard)
				r.With(auth.Require("report:read")).Get("/sales", api.GetSales)
				r.With(auth.Require("report:read")).Get("/profitability", api.GetProfitability)
				r.With(auth.Require("report:read")).Get("/profitability/{categoryId}", api.GetProfitabilityDrilldown)
				r.With(auth.Require("report:read")).Get("/top-sellers", api.GetTopSellers)
				r.With(auth.Require("report:read")).Get("/heatmap", api.GetHeatmap)
				r.With(auth.Require("report:read")).Get("/category-mix", api.GetCategoryMix)
				r.With(auth.Require("report:read")).Get("/table-mix", api.GetTableMix)
				r.With(auth.Require("report:read")).Get("/velocity", api.GetVelocity)
			})

			// RBAC: list the manifest of available permissions + CRUD on
			// tenant-scoped roles. The system 'owner' row is protected by
			// DB trigger so the handler doesn't need extra guards.
			r.With(auth.Require("role:read")).Get("/permissions", api.ListPermissionManifest)
			r.Route("/roles", func(r chi.Router) {
				r.With(auth.Require("role:read")).Get("/", api.ListRoles(rbacRepo))
				r.With(auth.Require("role:create")).Post("/", api.CreateRole(rbacRepo))
				r.With(auth.Require("role:read")).Get("/{id}", api.GetRole(rbacRepo))
				r.With(auth.Require("role:update")).Patch("/{id}", api.UpdateRole(rbacRepo))
				r.With(auth.Require("role:delete")).Delete("/{id}", api.DeleteRole(rbacRepo))
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
