package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/pewssh/cafe-mgmt/api/internal/alert"
	"github.com/pewssh/cafe-mgmt/api/internal/api"
	"github.com/pewssh/cafe-mgmt/api/internal/api/super"
	"github.com/pewssh/cafe-mgmt/api/internal/appctx"
	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/billing"
	"github.com/pewssh/cafe-mgmt/api/internal/config"
	"github.com/pewssh/cafe-mgmt/api/internal/db"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
	"github.com/pewssh/cafe-mgmt/api/internal/rbac"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/respond"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
	"github.com/pewssh/cafe-mgmt/api/internal/tenant"
)

// requestTimeout attaches a deadline to the request context so handlers (and
// the DB calls within them) abort promptly rather than blocking indefinitely.
func requestTimeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func NewRouter(cfg config.Config, logger *slog.Logger, pool *pgxpool.Pool, hub *realtime.Hub, store storage.Storage, mailer *mail.Mailer) http.Handler {
	rbacRepo := rbac.NewRepo(pool, rbac.NewCache(4096))
	// Bootstrap super-admin access: any user logging in with an allowlisted
	// email is upserted into platform_admins (see auth.SyncPlatformAdmin).
	auth.SetPlatformAllowlist(cfg.PlatformAdminEmails)
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(slogRequest(logger))
	r.Use(recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(SecurityHeaders(cfg.Env == "prod"))

	// CORS runs BEFORE the rate limiters: a browser-fired preflight (OPTIONS)
	// is answered and short-circuited here, so it never consumes a caller's
	// rate-limit quota (RateLimitByIP also skips OPTIONS as belt-and-suspenders).
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Tenant-ID", "X-Requested-With"},
		ExposedHeaders:   []string{"X-Request-ID"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Global throttle covering EVERY endpoint (default 600 req/IP/min — 10 rps
	// sustained, with a generous burst). Registered before any route, so health
	// checks, /public, /auth, /v1 and /super all inherit it. Specific surfaces
	// tighten further below. All limits are env-tunable (see RateLimitConfig).
	r.Use(RateLimitByIP("global", cfg.RateLimit.GlobalPerMin, time.Minute))

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
	// transaction middleware. Per-IP throttle on the upgrade itself: a
	// reconnecting client needs a handful per minute, so 50 leaves headroom
	// while capping connection-exhaustion floods.
	r.With(RateLimitByIP("ws", 50, time.Minute)).Get("/ws", realtime.Handler(pool, hub, cfg.CORSOrigins))

	// Public, unauthenticated surface — the customer-facing QR menu. No bearer
	// token and no membership: the tenant is resolved from the {slug} path
	// param, and RLS (via TxMiddleware) still scopes every query to that one
	// cafe. Read-only. Kept OUT of /v1 so the authed API surface stays clearly
	// separated from what's world-readable.
	r.Route("/public", func(r chi.Router) {
		r.Use(middleware.Compress(5, "application/json"))
		r.Use(requestTimeout(15 * time.Second))
		// Tighter per-IP envelope than the global limit — an anonymous endpoint
		// is the most scrape-able surface, and a guest loads the menu a handful
		// of times at most.
		r.Use(RateLimitByIP("public", cfg.RateLimit.PublicPerMin, time.Minute))
		r.Route("/menu/{slug}", func(r chi.Router) {
			r.Use(tenant.SlugParamMiddleware(pool))
			r.Use(db.TxMiddleware(pool))
			r.Get("/", api.GetPublicMenu)
		})
		// Customer-facing plan tiers for the request-access form's picker.
		r.Get("/plans", api.ListPublicPlans(pool))
		// Inbound "request access" lead capture — the spammiest surface (it
		// writes a row). Layer two IP caps on top of the group limit: a burst
		// cap (default 2/min) to stop rapid-fire submits, plus a sustained
		// hourly cap so a slow drip can't accumulate. Both env-tunable.
		r.With(
			RateLimitByIP("request_access_min", cfg.RateLimit.RequestAccessPerMin, time.Minute),
			RateLimitByIP("request_access_hour", cfg.RateLimit.RequestAccessPerHour, time.Hour),
		).Post("/request-access", api.RequestAccess(pool))
	})

	// Auth routes — no tenant required.
	r.Route("/auth", func(r chi.Router) {
		googleEnabled := cfg.Google.IsConfigured()
		devLoginEnabled := cfg.IsDev()
		// Email-OTP needs a working mailer in prod. In dev we still mount
		// the routes and log codes to the server console, so the SPA can
		// exercise the full flow without SendGrid creds.
		emailOtpEnabled := mailer != nil || cfg.IsDev()

		// Email-OTP login — the alternative to Google for users without a
		// signed-in Google account on the device.
		//
		// These endpoints are deliberately registered OUTSIDE the tighter per-IP
		// /auth envelope below. A whole café sits behind one public NAT IP, so a
		// shared per-IP bucket would let a few staff (plus the SPA's background
		// calls) exhaust the quota and 429 the NEXT person's first code request.
		// They self-throttle per-EMAIL instead (resend cooldown + hourly cap in
		// otp.go), with only a loose per-IP hourly backstop, and still inherit the
		// global per-IP guard registered above. verify-otp is bounded per-code by
		// MaxAttempts, which is likewise immune to co-located users.
		otpParams := auth.OTPParams{
			CodeLength:     cfg.OTP.CodeLength,
			TTLSeconds:     cfg.OTP.TTLSeconds,
			ResendCooldown: cfg.OTP.ResendCooldown,
			MaxAttempts:    cfg.OTP.MaxAttempts,
			EmailHourlyCap: cfg.OTP.EmailHourlyCap,
			IPHourlyCap:    cfg.OTP.IPHourlyCap,
		}
		r.Post("/request-otp", auth.RequestOTPHandler(pool, mailer, otpParams, cfg.IsDev()))
		r.Post("/verify-otp", auth.VerifyOTPHandler(pool, otpParams))

		// Everything else on /auth keeps a tighter per-IP envelope (default
		// 120/min) layered on the global limit so a single host can't grind on
		// login/refresh.
		r.Group(func(r chi.Router) {
			r.Use(RateLimitByIP("auth", cfg.RateLimit.AuthPerMin, time.Minute))

			// /auth/config tells the unauthenticated SPA which login methods are
			// available so it can render the matching buttons.
			r.Get("/config", auth.ConfigHandler(googleEnabled, devLoginEnabled, emailOtpEnabled))

			// Google OIDC if configured.
			if g, err := auth.NewGoogle(context.Background(), cfg.Google, pool, cfg.RootDomain, cfg.SecureCookies, cfg.PostLoginRedirectURL); err == nil && g != nil {
				r.Get("/google", g.Start)
				r.Get("/google/callback", g.Callback)
				// Native mobile posts a Google ID token here and gets tokens back
				// as JSON (no browser redirect / handoff code).
				r.Post("/google/native", g.NativeSignIn)
				// SPA exchanges the one-time handoff code from the callback for tokens.
				r.Post("/exchange", auth.ExchangeHandler(pool))
			}
			r.Post("/logout", auth.LogoutHandler(pool))

			// Refresh-token rotation. Active clients hit this once per access-token
			// TTL (~4×/hour), so the group's per-IP envelope is ample headroom
			// even for a cafe full of staff behind one NAT IP.
			r.Post("/refresh", auth.RefreshHandler(pool))

			// Dev-only login bypass.
			if devLoginEnabled {
				r.Post("/dev-login", auth.DevLoginHandler(pool))
			}
		})
	})

	// /v1 surface. Each route group resolves its own context (tenant or no
	// tenant) BEFORE TxMiddleware so the tx is begun with the right
	// app.tenant_id / app.user_id values for RLS.
	r.Route("/v1", func(r chi.Router) {
		// gzip JSON responses at the origin. CloudFront (Compress=false +
		// AllViewer origin policy) forwards Accept-Encoding here and passes the
		// encoded body straight through, so this shrinks the larger payloads
		// (reports, history, order lists) on slow links regardless of the CDN.
		// Scoped to /v1 only — never wraps the hijacked /ws connection.
		r.Use(middleware.Compress(5, "application/json"))
		// Bound every /v1 request so a handler blocked acquiring a pooled DB
		// connection (or on a slow query) fails fast instead of hanging until
		// the client/proxy gives up. The HTTP WriteTimeout does NOT cancel the
		// request context, so without this a connection-starved request could
		// wait ~60s. /ws is mounted outside this group and is unaffected.
		r.Use(requestTimeout(25 * time.Second))
		r.Use(auth.BearerMiddleware(pool))

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
			// Global logout: revoke every session + bump token_version so all
			// outstanding access tokens are rejected. Authenticated, no tenant.
			r.Post("/sessions/logout-all", auth.LogoutAllHandler(pool))
			// NOTE: self-serve workspace creation (POST /v1/tenants) has been
			// removed. Tenants are now created only by a platform admin via the
			// /super console (direct create or by approving a tenant request),
			// which provisions the tenant + an owner invite. See internal/api/super.
			// GDPR endpoints — operate on the authenticated user across all
			// their workspaces. Tenant context is optional here because the
			// operations are identity-scoped, not workspace-scoped.
			// Both are expensive (full cross-workspace export / destructive
			// delete), so they get tight per-IP envelopes on top of auth.
			r.With(RateLimitByIP("gdpr_export", 10, time.Hour)).Get("/me/export", api.ExportMyData)
			r.With(RateLimitByIP("gdpr_delete", 5, time.Hour)).Delete("/me", api.DeleteMyAccount(pool))
		})

		// Tenant-scoped routes — must be an active member of the
		// resolved tenant; tx is begun with the tenant + user contexts set.
		// Every route declares its required permission via auth.Require(...);
		// the gate is enforced after RequireMember loads the permission set.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(tenant.Middleware(pool, cfg.RootDomain))
			r.Use(auth.RequireMember(pool, rbacRepo))
			// Block mutating requests when the tenant is write-locked (manual
			// super-admin lock or trial expired past grace). Reads still pass.
			// Mounted before TxMiddleware so a locked write never even opens a tx.
			r.Use(billing.WriteGate)
			r.Use(db.TxMiddleware(pool))

			// Short-lived ticket so the browser WebSocket can authenticate
			// without an Authorization header. Any active member may open the
			// realtime feed, so no extra permission gate.
			r.Post("/ws-ticket", api.IssueWSTicket(pool))

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
			// Bulk menu import (categories + items in one transactional upsert).
			// Gated: an onboarding accelerator on higher tiers. Manual category/
			// item entry stays available to every plan. Handles its own dry-run.
			r.With(auth.Require("menu:create"), billing.RequireFeature(billing.FeatureMenuImport)).Post("/menu/import", api.BulkImportMenu)
			// Generic catalog image upload (category banners + item photos).
			// Returns the object URL; the caller persists it via create/update.
			r.With(auth.RequireAny("menu:create", "menu:update")).Post("/menu/images", api.UploadMenuImage(store))

			// In-app feedback channel (0038). Open to every member — anyone who
			// hits a snag should be able to report it, no permission gate. The
			// reporter can read back only their own submissions to track status.
			r.Route("/bug-reports", func(r chi.Router) {
				r.Post("/", api.CreateBugReport(store))
				r.Get("/mine", api.ListMyBugReports)
				r.Get("/{id}/attachments/{attId}", api.DownloadBugAttachment(store))
			})

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

			// Staff registry + private personal documents (0023). Documents are
			// uploaded private and only ever streamed back through the
			// staff:read-gated /file endpoint — never via a public URL.
			r.Route("/staff", func(r chi.Router) {
				r.Use(billing.RequireFeature(billing.FeatureStaffHR))
				r.With(auth.Require("staff:read")).Get("/", api.ListStaff)
				r.With(auth.Require("staff:create")).Post("/", api.CreateStaff)
				r.With(auth.Require("staff:read")).Get("/{id}", api.GetStaff)
				r.With(auth.Require("staff:update")).Patch("/{id}", api.UpdateStaff)
				r.With(auth.Require("staff:delete")).Delete("/{id}", api.DeleteStaff)
				r.With(auth.Require("staff:upload_document")).Post("/{id}/documents", api.UploadStaffDocument(store))
				r.With(auth.Require("staff:read")).Get("/{id}/documents/{docId}/file", api.DownloadStaffDocument(store))
				r.With(auth.Require("staff:delete_document")).Delete("/{id}/documents/{docId}", api.DeleteStaffDocument(store))
				// Salary pay-history ledger (0033). Reuses staff:read/update — no
				// dedicated permission keys.
				r.With(auth.Require("staff:read")).Get("/{id}/pay", api.ListStaffPay)
				r.With(auth.Require("staff:update")).Post("/{id}/pay", api.CreateStaffPay)
				r.With(auth.Require("staff:update")).Delete("/{id}/pay/{payId}", api.DeleteStaffPay)
			})
			r.Route("/tables", func(r chi.Router) {
				r.With(auth.Require("table:read")).Get("/", api.ListServiceTables)
				r.With(auth.Require("table:create")).Post("/", api.CreateServiceTable)
				r.With(auth.Require("table:update")).Patch("/{id}", api.UpdateServiceTable)
				r.With(auth.Require("table:delete")).Delete("/{id}", api.DeleteServiceTable)
			})
			// Outlets = prep destinations (Kitchen, Bar, …). Read is open to
			// anyone who reads the menu/kitchen (they need outlet names to route
			// and label tickets); mutation is outlet:*-gated.
			r.Route("/outlets", func(r chi.Router) {
				// Reading outlets stays open (tickets need outlet names to route/
				// label, and the default single outlet must always work). MANAGING
				// more than one outlet is the gated multi_outlet feature.
				multiOutlet := billing.RequireFeature(billing.FeatureMultiOutlet)
				r.With(auth.Require("outlet:read")).Get("/", api.ListOutlets)
				r.With(auth.Require("outlet:create"), multiOutlet).Post("/", api.CreateOutlet)
				r.With(auth.Require("outlet:update"), multiOutlet).Patch("/{id}", api.UpdateOutlet)
				r.With(auth.Require("outlet:delete"), multiOutlet).Delete("/{id}", api.DeleteOutlet)
			})
			r.Route("/orders", func(r chi.Router) {
				r.With(auth.Require("order:read")).Get("/", api.ListOrders)
				// Day-wise closed-order history (optionally by table). Static
				// segment — chi prioritises it over the /{id} wildcard below.
				r.With(auth.Require("order:read")).Get("/history", api.GetOrderHistory)
				r.With(auth.Require("order:create")).Post("/", api.OpenOrder(hub))
				r.With(auth.Require("order:read")).Get("/{id}", api.GetOrder)
				r.With(auth.Require("order:add_items")).Post("/{id}/items", api.AddOrderItems(hub))
				// Move/merge a tab to another table (or detach to take-away).
				r.With(auth.Require("order:create")).Post("/{id}/move", api.MoveOrder(hub))
				// Name a walk-in / "Unknown +" tab (free-text label).
				r.With(auth.Require("order:create")).Post("/{id}/rename", api.RenameOrder(hub))
				r.With(auth.Require("order:update_item")).Patch("/{id}/items/{itemId}", api.UpdateOrderItem)
				r.With(auth.Require("order:void_item")).Post("/{id}/items/{itemId}/void", api.VoidOrderItem(hub))
				r.With(auth.Require("order:send_kitchen")).Post("/{id}/send-to-kitchen", api.SendOrderToKitchen(hub))
				r.With(auth.Require("order:cancel")).Post("/{id}/cancel", api.CancelOrder(hub))

				// Payments + close (M5).
				r.With(auth.Require("order:read")).Get("/{id}/quote", api.GetSettleQuote)
				r.With(auth.Require("payment:read")).Get("/{id}/payments", api.ListOrderPayments)
				r.With(auth.Require("payment:record")).Post("/{id}/payments", api.RecordPayment(hub))
				r.With(auth.Require("payment:delete")).Delete("/{id}/payments/{paymentId}", api.DeletePayment(hub))
				r.With(auth.Require("payment:reclassify")).Post("/{id}/payments/{paymentId}/reclassify", api.ReclassifyPayment(hub))
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
				r.Use(billing.RequireFeature(billing.FeatureInventory))
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
				r.With(auth.Require("menu:read")).Get("/", api.GetMenuItemLinks)
				r.With(auth.Require("menu:update")).Put("/", api.PutMenuItemLinks)
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
				r.With(auth.Require("expense:read")).Get("/vendors", api.ListExpenseVendors)
				r.With(auth.Require("expense:read")).Get("/{id}", api.GetExpense)
				r.With(auth.Require("expense:update")).Patch("/{id}", api.UpdateExpense)
				r.With(auth.Require("expense:delete")).Delete("/{id}", api.DeleteExpense)
			})

			// Shifts / cash drawer (M10) + per-shift drawer ledger (0009).
			r.Route("/shifts", func(r chi.Router) {
				r.With(auth.Require("shift:read")).Get("/", api.ListShifts)
				r.With(auth.Require("shift:read")).Get("/current", api.GetCurrentShift)
				r.With(auth.Require("shift:create")).Post("/open", api.OpenShift)
				r.With(auth.Require("shift:settle")).Post("/{id}/close", api.CloseShift(mailer))
				r.With(auth.Require("shift:read")).Get("/{id}/cash-drops", api.ListCashDrops)
				r.With(auth.Require("shift:read")).Get("/{id}/payments", api.ListShiftPayments)
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
				// cafe-balance / cafe-summary are NOT feature-gated: the basic
				// Dashboard reads them for its always-on "Cafe balance" KPI. The
				// owner_finance feature gates only owner-management (equity,
				// ledger, investments, loans, owner-cash).
				ownerFinance := billing.RequireFeature(billing.FeatureOwnerFinance)
				r.With(auth.Require("finance:read")).Get("/cafe-balance", api.GetCafeBalance)
				r.With(auth.Require("finance:read")).Get("/cafe-summary", api.GetCafeSummary)
				r.With(auth.Require("finance:read"), ownerFinance).Get("/owners", api.ListCafeOwners)
				r.With(auth.Require("finance:create_owner"), ownerFinance).Post("/owners", api.CreateCafeOwner(hub))
				r.With(auth.Require("finance:update_owner"), ownerFinance).Patch("/owners/{id}", api.UpdateCafeOwner(hub))
				r.With(auth.Require("finance:delete_owner"), ownerFinance).Post("/owners/{id}/deactivate", api.DeactivateCafeOwner(hub))
				r.With(auth.Require("finance:read"), ownerFinance).Get("/owner-ledger", api.ListOwnerLedger)
				r.With(auth.Require("finance:correct"), ownerFinance).Post("/owner-ledger/{id}/correct", api.CorrectOwnerLedger(hub))
				r.With(auth.Require("finance:invest"), ownerFinance).Post("/investments", api.CreateInvestment(hub))
				r.With(auth.Require("finance:payout"), ownerFinance).Post("/payouts", api.CreatePayouts(hub))
				r.With(auth.Require("finance:repay"), ownerFinance).Post("/loans/{id}/repay", api.RepayLoan(hub))
				// Owner cash custody (0034): cash an owner takes from the drawer
				// and reconciles via bank deposit / cafe expense / return.
				r.With(auth.Require("finance:read"), ownerFinance).Get("/owner-cash", api.ListOwnerCash)
				r.With(auth.Require("finance:owner_cash"), ownerFinance).Post("/owner-cash/withdrawals", api.CreateOwnerCashWithdrawal(hub))
				r.With(auth.Require("finance:owner_cash"), ownerFinance).Post("/owner-cash/returns", api.CreateOwnerCashReturn(hub))
				r.With(auth.Require("finance:owner_cash"), ownerFinance).Post("/owner-cash/deposits", api.CreateOwnerCashDeposit(hub))
				r.With(auth.Require("finance:owner_cash"), ownerFinance).Delete("/owner-cash/{id}", api.DeleteOwnerCashEntry(hub))
			})

			// Tenant settings + branding (M12).
			r.With(auth.Require("tenant:read")).Get("/tenant", api.GetTenant)
			r.With(auth.Require("tenant:update")).Patch("/tenant", api.UpdateTenant)
			r.With(auth.Require("tenant:upload_logo")).Post("/tenant/logo", api.UploadLogo(store))
			r.With(auth.Require("tenant:upload_logo")).Post("/tenant/receipt-image", api.UploadReceiptImage(store))

			// House tabs (stakeholder running ledgers). Gated feature — the
			// order-settle "charge to tab" option degrades gracefully on the FE
			// when the plan lacks it (the tab list here 403s).
			r.Route("/house-tabs", func(r chi.Router) {
				r.Use(billing.RequireFeature(billing.FeatureHouseTabs))
				r.With(auth.Require("house_tab:read")).Get("/", api.ListHouseTabs)
				r.With(auth.Require("house_tab:create")).Post("/", api.CreateHouseTab)
				r.With(auth.Require("house_tab:read")).Get("/{id}", api.GetHouseTab)
				r.With(auth.Require("house_tab:update")).Patch("/{id}", api.UpdateHouseTab)
				r.With(auth.Require("house_tab:delete")).Delete("/{id}", api.DeleteHouseTab)
				r.With(auth.Require("house_tab:settle")).Post("/{id}/settlements", api.CreateHouseTabSettlement)
			})

			// Audit log — premium feature, gated on top of the audit:read
			// permission so non-premium tenants get an upgrade prompt.
			r.Route("/audit", func(r chi.Router) {
				auditFeature := billing.RequireFeature(billing.FeatureAuditLogs)
				r.With(auth.Require("audit:read"), auditFeature).Get("/", api.ListAuditEvents)
				r.With(auth.Require("audit:read"), auditFeature).Get("/actors", api.ListAuditActors)
			})

			// Reports (M8 + M9 + analytics expansion).
			r.Route("/reports", func(r chi.Router) {
				r.With(auth.Require("report:read")).Get("/dashboard", api.GetDashboard)
				r.With(auth.Require("report:read")).Get("/sales", api.GetSales)
				// Hourly order/sales breakdown for a single day. Core operational
				// data (staffing, "how busy was each hour"), so it is NOT gated on
				// advanced analytics like the panels below.
				r.With(auth.Require("report:read")).Get("/hourly", api.GetHourly)
				// Profitability (P&L) — its own gated feature, separate from the
				// advanced_analytics umbrella below.
				profitability := billing.RequireFeature(billing.FeatureProfitability)
				r.With(auth.Require("report:read"), profitability).Get("/profitability", api.GetProfitability)
				r.With(auth.Require("report:read"), profitability).Get("/profitability/{categoryId}", api.GetProfitabilityDrilldown)
				// Advanced analytics — premium feature. Gated on top of the
				// report:read permission so lower tiers see an upgrade prompt.
				advAnalytics := billing.RequireFeature(billing.FeatureAdvancedAnalytics)
				r.With(auth.Require("report:read"), advAnalytics).Get("/top-sellers", api.GetTopSellers)
				// Comprehensive movers report (all items, filters, paging) + the
				// single-item drilldown behind it.
				r.With(auth.Require("report:read"), advAnalytics).Get("/movers", api.GetMovers)
				r.With(auth.Require("report:read"), advAnalytics).Get("/item/{menuItemId}", api.GetItemAnalytics)
				r.With(auth.Require("report:read"), advAnalytics).Get("/heatmap", api.GetHeatmap)
				r.With(auth.Require("report:read"), advAnalytics).Get("/category-mix", api.GetCategoryMix)
				r.With(auth.Require("report:read"), advAnalytics).Get("/table-mix", api.GetTableMix)
				r.With(auth.Require("report:read"), advAnalytics).Get("/velocity", api.GetVelocity)
			})

			// RBAC: list the manifest of available permissions + CRUD on
			// tenant-scoped roles. The system 'owner' row is protected by
			// DB trigger so the handler doesn't need extra guards.
			r.With(auth.Require("role:read")).Get("/permissions", api.ListPermissionManifest)
			// Reading roles stays open (Members UI needs the role list to assign
			// them). CREATING/EDITING custom roles is the gated custom_roles feature.
			r.Route("/roles", func(r chi.Router) {
				customRoles := billing.RequireFeature(billing.FeatureCustomRoles)
				r.With(auth.Require("role:read")).Get("/", api.ListRoles(rbacRepo))
				r.With(auth.Require("role:create"), customRoles).Post("/", api.CreateRole(rbacRepo))
				r.With(auth.Require("role:read")).Get("/{id}", api.GetRole(rbacRepo))
				r.With(auth.Require("role:update"), customRoles).Patch("/{id}", api.UpdateRole(rbacRepo))
				r.With(auth.Require("role:delete"), customRoles).Delete("/{id}", api.DeleteRole(rbacRepo))
			})
		})

		// Super-admin console — site-wide, NOT tenant-scoped. Authority comes
		// purely from platform_admins (env allowlist or in-console), never from
		// tenant RBAC. No tenant.Middleware / RequireMember here; cross-tenant
		// reads use the SECURITY DEFINER functions from migration 0025.
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			r.Use(auth.RequirePlatformAdmin(pool))
			r.Use(db.TxMiddleware(pool)) // sets app.user_id only (no tenant)

			r.Route("/super", func(r chi.Router) {
				r.Get("/tenants", super.ListTenants)
				r.Post("/tenants", super.CreateTenant(rbacRepo))
				r.Get("/tenants/{id}", super.GetTenantDetail)
				r.Patch("/tenants/{id}/plan", super.ChangePlan)
				r.Patch("/tenants/{id}/member-limit", super.SetMemberLimitOverride)
				r.Patch("/tenants/{id}/features", super.SetFeatureOverrides)
				r.Post("/tenants/{id}/extend-trial", super.ExtendTrial)
				r.Patch("/tenants/{id}/subscription", super.SetSubscription)
				r.Get("/tenants/{id}/payments", super.ListPayments)
				r.Post("/tenants/{id}/payments", super.RecordPayment)
				r.Post("/tenants/{id}/write-lock", super.ToggleWriteLock)
				r.Post("/tenants/{id}/suspend", super.SuspendTenant)
				r.Post("/tenants/{id}/reactivate", super.ReactivateTenant)
				r.Get("/tenants/{id}/data-summary", super.GetTenantDataSummary)
				r.Post("/tenants/{id}/delete", super.DeleteTenant)

				r.Get("/features", super.ListFeatureRegistry)
				r.Route("/plans", func(r chi.Router) {
					r.Get("/", super.ListPlans)
					r.Post("/", super.CreatePlan)
					r.Patch("/{id}", super.UpdatePlan)
					r.Delete("/{id}", super.DeletePlan)
				})

				r.Route("/requests", func(r chi.Router) {
					r.Get("/", super.ListRequests)
					r.Post("/{id}/approve", super.ApproveRequest(rbacRepo))
					r.Post("/{id}/reject", super.RejectRequest)
				})

				r.Route("/admins", func(r chi.Router) {
					r.Get("/", super.ListPlatformAdmins)
					r.Post("/", super.AddPlatformAdmin)
					r.Delete("/{userId}", super.RemovePlatformAdmin)
				})

				r.Get("/audit", super.ListPlatformAudit)

				// Bug / issue triage (0038). The list/detail/patch read across
				// tenants via the platform-admin RLS policy; the attachment proxy
				// reuses the tenant handler — same RLS-gated query, the platform
				// policy makes any tenant's screenshot visible here.
				r.Route("/bug-reports", func(r chi.Router) {
					r.Get("/", super.ListBugReports)
					r.Get("/{id}", super.GetBugReport)
					r.Patch("/{id}", super.UpdateBugReport)
					r.Post("/{id}/delete", super.DeleteBugReport)
					r.Get("/{id}/attachments/{attId}", api.DownloadBugAttachment(store))
				})
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
//
// recoverer replaces chi's middleware.Recoverer so a panic is captured as a
// structured slog record (with stack) the log aggregator can parse, rather than
// chi's plain-text stderr dump. It writes a masked 500 and lets the request
// finish; slogRequest (registered before this) then observes the 500 and fires
// the single operational alert, so panics don't double-page.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			// Honor the sentinel for a deliberately aborted handler.
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			ctx := r.Context()
			appctx.Logger(ctx).ErrorContext(ctx, "http.panic",
				"panic", fmt.Sprintf("%v", rec),
				"method", r.Method,
				"path", r.URL.Path,
				"stack", string(debug.Stack()),
			)
			// recoverer runs inside slogRequest, so the errCaptureWriter is
			// reachable (directly, or under wrappers a deeper panic unwound
			// through): name the panic in the alert. The full stack stays in the
			// log line above — too big for a webhook.
			if c := respond.FindCapturer(w); c != nil {
				c.CaptureServerError("panic", fmt.Sprintf("%v", rec))
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"code":    "internal_error",
				"message": "an internal error occurred",
			})
		}()
		next.ServeHTTP(w, r)
	})
}

// errCaptureWriter wraps the response writer so the sanitized detail of a 5xx
// (stripped from the client body by respond.Err) can be read back by
// slogRequest — and thus logged with req_id and folded into the operational
// alert. Without this the error text lands in a separate slog record that
// carries no req_id, leaving the alert impossible to explain.
type errCaptureWriter struct {
	middleware.WrapResponseWriter
	kind, detail string
}

// CaptureServerError records the first 5xx detail seen for this request (the
// first is the root cause; later writes are usually fallout).
func (c *errCaptureWriter) CaptureServerError(kind, detail string) {
	if c.kind == "" {
		c.kind, c.detail = kind, detail
	}
}

// Unwrap lets http.ResponseController (and thus WebSocket hijack via
// coder/websocket) reach the underlying writer through this wrapper — mirrors
// the passthrough at internal/db/pool.go.
func (c *errCaptureWriter) Unwrap() http.ResponseWriter { return c.WrapResponseWriter }

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
			// Install the mutable holder so tenant/user resolved by downstream
			// middleware become visible to this summary line + the 5xx alert.
			// (Context values set downstream aren't otherwise reachable here —
			// each middleware hands a new request forward, not back.)
			ctx = appctx.WithRequestInfo(ctx)
			r = r.WithContext(ctx)

			rl.DebugContext(ctx, "http.request.start",
				"remote", r.RemoteAddr,
				"ua", r.UserAgent(),
			)

			ww := &errCaptureWriter{WrapResponseWriter: middleware.NewWrapResponseWriter(w, r.ProtoMajor)}
			next.ServeHTTP(ww, r)

			// re-fetch ctx — handlers and downstream middleware may have
			// added tenant/user to it. The summary line's tenant/user/req_id are
			// injected by the logging.contextHandler at emit time, so they are
			// NOT appended here (doing so would duplicate the keys).
			ctx = r.Context()
			args := []any{
				"status", ww.Status(),
				"bytes", ww.BytesWritten(),
				"dur_ms", time.Since(start).Milliseconds(),
			}
			// The error detail captured off respond.Err rides the same line as
			// req_id/method/path/tenant/user, so ONE structured record explains
			// the 5xx — no more correlating a detached slog line by timestamp.
			if ww.kind != "" {
				args = append(args, "err_kind", ww.kind, "err", ww.detail)
			}

			switch {
			case ww.Status() >= 500:
				if respond.ClientGone(r.Context()) {
					// The client went away mid-request (canceled context), so the
					// next DB/pool op failed with context.Canceled and bubbled up
					// as a 5xx. That's fallout from the disconnect, not a server
					// fault — log it (warn) but do NOT page. Note: only
					// context.Canceled is suppressed; a DeadlineExceeded is a
					// server-side timeout and still falls through to alert below.
					rl.WarnContext(ctx, "http.client_gone", args...)
					break
				}
				rl.ErrorContext(ctx, "http.request", args...)
				// Single alert path for every 5xx — handler-returned errors,
				// panics-caught-as-500, timeouts. One coarse throttle key
				// ("http.5xx") deliberately collapses an outage into one page
				// rather than a storm. The captured detail + tenant/user make
				// the page self-explanatory; the full stack stays in the logs.
				ev := alert.Event{
					Level: slog.LevelError,
					Name:  "http.5xx",
					Attrs: []any{"status", ww.Status(), "method", r.Method, "path", r.URL.Path},
				}
				if ww.kind != "" {
					ev.Err = fmt.Errorf("%s: %s", ww.kind, ww.detail)
				}
				// req_id + tenant + user are folded in from the context (same
				// helper every other alert uses), so the page is self-explanatory.
				alert.Default().Notify(ctx, alert.WithContext(ctx, ev))
			case ww.Status() >= 400:
				rl.WarnContext(ctx, "http.request", args...)
			default:
				rl.InfoContext(ctx, "http.request", args...)
			}
		})
	}
}
