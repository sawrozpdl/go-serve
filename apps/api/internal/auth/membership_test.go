package auth

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// safeToRetryErr mimics a pgconn connection error that never carried the query,
// which pgconn.SafeToRetry recognises via the SafeToRetry() method.
type safeToRetryErr struct{ safe bool }

func (e safeToRetryErr) Error() string     { return "conn reset before send" }
func (e safeToRetryErr) SafeToRetry() bool { return e.safe }

func TestIsTransientDBError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"no rows is not transient", pgx.ErrNoRows, false},
		{"plain query error is not transient", errors.New("syntax error"), false},
		{"safe-to-retry connection error", safeToRetryErr{safe: true}, true},
		{"wrapped safe-to-retry", fmt.Errorf("begin tx: %w", safeToRetryErr{safe: true}), true},
		{"safe-to-retry=false is not transient", safeToRetryErr{safe: false}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTransientDBError(tc.err); got != tc.want {
				t.Errorf("isTransientDBError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
