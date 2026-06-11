package api

import (
	"io"
	"log/slog"
)

// discardLogger returns a logger that drops everything — keeps test output
// clean while still exercising the handlers' logging calls.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
