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
}

type Storage interface {
	Put(ctx context.Context, key string, r io.Reader, opts PutOpts) (publicURL string, err error)
	Delete(ctx context.Context, key string) error
}
