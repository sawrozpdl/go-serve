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
	// Private marks the object as NOT world-readable. Used for sensitive
	// uploads (e.g. staff ID documents) that must only ever be served through
	// an authenticated, permission-checked API endpoint — never via the
	// returned URL/public path. The default (false) keeps the existing
	// public-by-URL behaviour for logos and menu photos.
	Private bool
}

type Storage interface {
	Put(ctx context.Context, key string, r io.Reader, opts PutOpts) (publicURL string, err error)
	// Get streams a previously stored object back. Used by authenticated
	// proxy endpoints that gate access to private objects. The caller owns
	// the returned ReadCloser and must Close it.
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
}
