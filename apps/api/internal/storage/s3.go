package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// S3Config configures an S3-compatible backend. The same struct works for
// Supabase Storage, AWS S3, Cloudflare R2, Backblaze B2, and MinIO — the
// differences are entirely in these field values.
type S3Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	// PublicURLBase is the URL prefix the browser uses to fetch stored
	// objects. For Supabase public buckets:
	//   https://<ref>.storage.supabase.co/storage/v1/object/public/<bucket>
	// For AWS S3 with a CloudFront alias: https://cdn.example.com.
	// Required because S3 endpoints, public-object URLs, and CDN URLs do
	// not always coincide.
	PublicURLBase string
	// ForcePathStyle = true is required for Supabase, MinIO, and most
	// non-AWS providers. AWS S3 supports either style.
	ForcePathStyle bool
}

type S3Store struct {
	client        *s3.Client
	bucket        string
	publicURLBase string
}

func NewS3(ctx context.Context, c S3Config) (*S3Store, error) {
	if c.Bucket == "" {
		return nil, errors.New("storage: bucket required")
	}
	if c.PublicURLBase == "" {
		return nil, errors.New("storage: PublicURLBase required")
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(c.Region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretAccessKey, ""),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("storage: aws config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.ForcePathStyle
	})

	return &S3Store{
		client:        client,
		bucket:        c.Bucket,
		publicURLBase: strings.TrimRight(c.PublicURLBase, "/"),
	}, nil
}

func (s *S3Store) Put(ctx context.Context, key string, r io.Reader, opts PutOpts) (string, error) {
	in := &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   r,
		ACL:    types.ObjectCannedACLPublicRead,
	}
	if opts.ContentType != "" {
		in.ContentType = aws.String(opts.ContentType)
	}
	if opts.CacheControl != "" {
		in.CacheControl = aws.String(opts.CacheControl)
	}
	if _, err := s.client.PutObject(ctx, in); err != nil {
		return "", fmt.Errorf("storage: putobject: %w", err)
	}
	return s.publicURLBase + "/" + key, nil
}

func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("storage: deleteobject: %w", err)
	}
	return nil
}
