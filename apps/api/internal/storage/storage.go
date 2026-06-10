// Package storage is a minimal blob backend abstraction.
//
// Today we have two implementations: a local-disk store for dev and an
// S3-compatible store that talks to Supabase Storage in prod (and to
// AWS S3 / R2 / B2 / MinIO with only a config change).
package storage

import (
	"context"
	"io"
)

type PutOpts struct {
	ContentType  string
	CacheControl string
	// Public marks the object as world-readable via the returned URL (logos,
	// menu photos). The zero value is private: objects are only ever served
	// through an authenticated, permission-checked proxy endpoint (Get). New
	// upload endpoints that forget to set this leak nothing by default.
	Public bool
}

type Storage interface {
	Put(ctx context.Context, key string, r io.Reader, opts PutOpts) (publicURL string, err error)
	// Get streams a previously stored object back. Used by authenticated
	// proxy endpoints that gate access to private objects. The caller owns
	// the returned ReadCloser and must Close it.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
}
