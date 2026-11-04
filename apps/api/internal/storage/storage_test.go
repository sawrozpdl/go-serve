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

	url, err := s.Put(context.Background(), "sahan/logo-abc.png", strings.NewReader("hello world"), PutOpts{ContentType: "image/png", Public: true})
	if err != nil {
		t.Fatal(err)
	}
	if url != "/uploads/sahan/logo-abc.png" {
		t.Fatalf("unexpected url: %q", url)
	}

	got, err := os.ReadFile(filepath.Join(dir, "public", "sahan", "logo-abc.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello world" {
		t.Fatalf("file contents = %q", got)
	}
	rc, err := s.Get(context.Background(), "sahan/logo-abc.png")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "hello world" {
		t.Fatalf("Get = %q", b)
	}
}

func TestLocalStore_PrivateByDefault(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLocal(dir, "/uploads")
	if _, err := s.Put(context.Background(), "sahan/staff/x/doc.jpg", strings.NewReader("secret"), PutOpts{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "private", "sahan", "staff", "x", "doc.jpg")); err != nil {
		t.Fatalf("private object not under private/: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "sahan", "staff", "x", "doc.jpg")); !os.IsNotExist(err) {
		t.Fatalf("private object leaked into public/: %v", err)
	}
	rc, err := s.Get(context.Background(), "sahan/staff/x/doc.jpg")
	if err != nil {
		t.Fatal(err)
	}
	rc.Close()
}

func TestLocalStore_LegacyLayoutReadable(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLocal(dir, "/uploads")
	_ = os.MkdirAll(filepath.Join(dir, "old"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "old", "a.png"), []byte("legacy"), 0o644)
	rc, err := s.Get(context.Background(), "old/a.png")
	if err != nil {
		t.Fatal(err)
	}
	rc.Close()
	if err := s.Delete(context.Background(), "old/a.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old", "a.png")); !os.IsNotExist(err) {
		t.Fatalf("legacy object not deleted: %v", err)
	}
}

func TestLocalStore_Delete(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLocal(dir, "/uploads")
	_, _ = s.Put(context.Background(), "x.bin", strings.NewReader("x"), PutOpts{})
	_, _ = s.Put(context.Background(), "y.bin", strings.NewReader("y"), PutOpts{Public: true})

	for _, k := range []string{"x.bin", "y.bin"} {
		if err := s.Delete(context.Background(), k); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(context.Background(), k); err == nil {
			t.Fatalf("%s still readable after delete", k)
		}
		// Idempotent — deleting again must not error.
		if err := s.Delete(context.Background(), k); err != nil {
			t.Fatalf("delete missing key should be nil, got %v", err)
		}
	}
}

func TestLocalStore_RejectsTraversal(t *testing.T) {
	s, _ := NewLocal(t.TempDir(), "/uploads")
	_, err := s.Put(context.Background(), "../escape.txt", strings.NewReader("x"), PutOpts{})
	if err == nil {
		t.Fatal("expected error for traversal key")
	}
}

func TestPublicHandler_ServesOnlyPublicFiles(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewLocal(dir, "https://api.example.com/uploads")
	ctx := context.Background()
	if u, _ := s.Put(ctx, "cafe/logo-1.png", strings.NewReader("logo"), PutOpts{Public: true}); u != "https://api.example.com/uploads/cafe/logo-1.png" {
		t.Fatalf("public url = %q", u)
	}
	_, _ = s.Put(ctx, "cafe/expenses/r.jpg", strings.NewReader("receipt"), PutOpts{})
	_ = os.WriteFile(filepath.Join(dir, "public", "cafe", ".hidden"), []byte("h"), 0o644)

	srv := httptest.NewServer(http.StripPrefix("/uploads/", PublicHandler(s.PublicDir())))
	defer srv.Close()
	get := func(path string) (int, string, http.Header) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), resp.Header
	}

	if code, body, h := get("/uploads/cafe/logo-1.png"); code != 200 || body != "logo" || !strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Fatalf("public file: %d %q cache=%q", code, body, h.Get("Cache-Control"))
	}
	for _, p := range []string{
		"/uploads/cafe/expenses/r.jpg", // private object
		"/uploads/../private/cafe/expenses/r.jpg",
		"/uploads/cafe/",        // directory listing
		"/uploads/cafe",         // directory without slash
		"/uploads/",             // root listing
		"/uploads/cafe/.hidden", // dot file
	} {
		if code, body, _ := get(p); code == 200 || strings.Contains(body, "receipt") || strings.Contains(body, "logo-1") {
			t.Errorf("%s: got %d %q, want not served", p, code, body)
		}
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
