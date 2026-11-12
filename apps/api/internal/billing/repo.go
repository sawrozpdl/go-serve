package billing

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// LoadStateTx reads a tenant's raw plan inputs inside an existing transaction
// and computes the effective State. tenants/plans/plan_features are global
// (not RLS-scoped), so this works regardless of the tx's tenant GUC. Runs in a
// single round-trip via array_agg over plan_features.
func LoadStateTx(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (State, error) {
	var (
		planKey       string
		planLimit     *int
		limitOverride *int
		trialEndsAt   *time.Time
		paidThroughAt *time.Time
		billingState  string
		overridesRaw  []byte
		planFeatures  []string
		fiscalMode    bool
	)
	err := tx.QueryRow(ctx, `
		SELECT
			COALESCE(p.key, ''),
			p.member_limit,
			t.member_limit_override,
			t.trial_ends_at,
			t.paid_through_at,
			t.billing_state,
			t.feature_overrides,
			COALESCE(
				array_agg(pf.feature_key) FILTER (WHERE pf.feature_key IS NOT NULL),
				'{}'
			),
			tenant_fiscal_mode(t.id)
		FROM tenants t
		LEFT JOIN plans p          ON p.id = t.plan_id
		LEFT JOIN plan_features pf ON pf.plan_id = p.id
		WHERE t.id = $1
		GROUP BY t.id, p.key, p.member_limit, t.member_limit_override,
		         t.trial_ends_at, t.paid_through_at, t.billing_state, t.feature_overrides
	`, tenantID).Scan(
		&planKey, &planLimit, &limitOverride, &trialEndsAt, &paidThroughAt,
		&billingState, &overridesRaw, &planFeatures, &fiscalMode,
	)
	if err != nil {
		return State{}, err
	}

	var overrides FeatureOverrides
	if len(overridesRaw) > 0 {
		_ = json.Unmarshal(overridesRaw, &overrides) // best-effort; bad JSON → no overrides
	}

	st := ComputeState(
		time.Now(),
		planKey,
		planLimit,
		limitOverride,
		planFeatures,
		overrides,
		trialEndsAt,
		paidThroughAt,
		billingState == "write_locked",
	)
	// A café in IRD fiscal mode must keep a user activity log (procedure
	// 2082 §6.3(ख), 2074 §6(ञ)) whatever its plan or overrides say.
	if fiscalMode {
		st.Features[string(FeatureAuditLogs)] = true
	}
	return st, nil
}
