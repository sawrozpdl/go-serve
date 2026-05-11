package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLocalStore_PutThenReadBack(t *testing.T) {
	dir := t.TempDir()
	s, err := NewLocal(dir, "/uploads")
	if err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader("hello world")
	url, err := s.Put(context.Background(), "sahan/logo-abc.png", body, PutOpts{ContentType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	if url != "/uploads/sahan/logo-abc.png" {
		t.Fatalf("unexpected url: %q", url)
	}

	got, err := os.ReadFile(filepath.Join(dir, "sahan", "logo-abc.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello world" {
		t.Fatalf("file contents = %q", got)
	}
}

func TestLocalStore_Delete(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLocal(dir, "/uploads")
	_, _ = s.Put(context.Background(), "x.bin", strings.NewReader("x"), PutOpts{})

	if err := s.Delete(context.Background(), "x.bin"); err != nil {
		t.Fatal(err)
	}
	// Idempotent — deleting again must not error.
	if err := s.Delete(context.Background(), "x.bin"); err != nil {
		t.Fatalf("delete missing key should be nil, got %v", err)
	}
}

func TestLocalStore_RejectsTraversal(t *testing.T) {
	s, _ := NewLocal(t.TempDir(), "/uploads")
	_, err := s.Put(context.Background(), "../escape.txt", strings.NewReader("x"), PutOpts{})
	if err == nil {
		t.Fatal("expected error for traversal key")
	}
}

func TestS3Store_PutSendsExpectedRequest(t *testing.T) {
	var seen atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		// Path-style PUT against bucket: PUT /<bucket>/<key>
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
		}
		if !strings.HasPrefix(r.URL.Path, "/cafe-mgmt-uploads/sahan/") {
			t.Errorf("path = %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "image/png" {
			t.Errorf("content-type = %q", ct)
		}
		if cc := r.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("cache-control = %q", cc)
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "PNGDATA" {
			t.Errorf("body = %q", body)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s, err := NewS3(context.Background(), S3Config{
		Endpoint:        srv.URL,
		Region:          "us-east-1",
		Bucket:          "cafe-mgmt-uploads",
		AccessKeyID:     "k",
		SecretAccessKey: "s",
		PublicURLBase:   "https://cdn.example.com/cafe-mgmt-uploads",
		ForcePathStyle:  true,
	})
	if err != nil {
		t.Fatal(err)
	}

	url, err := s.Put(context.Background(), "sahan/logo-abc.png", strings.NewReader("PNGDATA"), PutOpts{
		ContentType:  "image/png",
		CacheControl: "public, max-age=31536000, immutable",
	})
	if err != nil {
		t.Fatal(err)
	}
	if url != "https://cdn.example.com/cafe-mgmt-uploads/sahan/logo-abc.png" {
		t.Fatalf("unexpected url: %q", url)
	}
	if seen.Load() == 0 {
		t.Fatal("server saw no request")
	}
}
