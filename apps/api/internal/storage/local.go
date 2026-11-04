package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// LocalStore keeps blobs on local disk. Objects are split by visibility:
//
//	<root>/public/<key>   — PutOpts.Public; served to browsers by PublicHandler
//	<root>/private/<key>  — everything else; only reachable through Get (the
//	                        authenticated, permission-checked proxy endpoints)
//
// The split is what makes the driver safe in production: the public file
// server is rooted at <root>/public, so a private object (staff ID document,
// expense receipt, bug screenshot) has no URL at all, however it is guessed.
// Objects written by older builds directly under <root>/<key> are still
// readable through Get but never served publicly.
type LocalStore struct {
	root          string
	publicURLBase string
}

const (
	localPublicDir  = "public"
	localPrivateDir = "private"
)

func NewLocal(rootDir, publicURLBase string) (*LocalStore, error) {
	if rootDir == "" {
		return nil, errors.New("storage: local rootDir required")
	}
	for _, d := range []string{rootDir, filepath.Join(rootDir, localPublicDir), filepath.Join(rootDir, localPrivateDir)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, fmt.Errorf("storage: mkdir %q: %w", d, err)
		}
	}
	return &LocalStore{
		root:          rootDir,
		publicURLBase: strings.TrimRight(publicURLBase, "/"),
	}, nil
}

// PublicDir is the directory PublicHandler serves.
func (s *LocalStore) PublicDir() string { return LocalPublicDir(s.root) }

// LocalPublicDir is the publicly served subdirectory of a local store rooted at root.
func LocalPublicDir(root string) string { return filepath.Join(root, localPublicDir) }

func (s *LocalStore) Put(_ context.Context, key string, r io.Reader, opts PutOpts) (string, error) {
	dir := localPrivateDir
	if opts.Public {
		dir = localPublicDir
	}
	clean, err := safeJoin(filepath.Join(s.root, dir), key)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
		return "", fmt.Errorf("storage: mkdir: %w", err)
	}
	// Write to a temp file and rename so a reader never sees a half-written
	// object and a failed upload leaves nothing behind.
	tmp, err := os.CreateTemp(filepath.Dir(clean), ".upload-*")
	if err != nil {
		return "", fmt.Errorf("storage: create: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		return "", fmt.Errorf("storage: write: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("storage: close: %w", err)
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return "", fmt.Errorf("storage: chmod: %w", err)
	}
	if err := os.Rename(tmp.Name(), clean); err != nil {
		return "", fmt.Errorf("storage: rename: %w", err)
	}
	return s.publicURLBase + "/" + key, nil
}

// candidates lists where a key may live, private first.
func (s *LocalStore) candidates(key string) ([]string, error) {
	var out []string
	for _, base := range []string{
		filepath.Join(s.root, localPrivateDir),
		filepath.Join(s.root, localPublicDir),
		s.root, // legacy layout (pre public/private split)
	} {
		p, err := safeJoin(base, key)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (s *LocalStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	paths, err := s.candidates(key)
	if err != nil {
		return nil, err
	}
	for _, p := range paths {
		if fi, err := os.Stat(p); err != nil || fi.IsDir() {
			continue
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, fmt.Errorf("storage: open: %w", err)
		}
		return f, nil
	}
	return nil, fmt.Errorf("storage: open %q: %w", key, fs.ErrNotExist)
}

func (s *LocalStore) Delete(_ context.Context, key string) error {
	paths, err := s.candidates(key)
	if err != nil {
		return err
	}
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			continue
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("storage: delete: %w", err)
		}
	}
	return nil
}

// PublicHandler serves files under dir (the store's PublicDir) with the URL
// prefix already stripped. It never lists directories and never serves dot
// files. Keys carry a random suffix and are never overwritten, so responses
// are cacheable forever.
func PublicHandler(dir string) http.Handler {
	fsrv := http.FileServer(noDirFS{http.Dir(dir)})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "" || strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		fsrv.ServeHTTP(w, r)
	})
}

// noDirFS hides directories and dot files from http.FileServer.
type noDirFS struct{ fs http.FileSystem }

func (n noDirFS) Open(name string) (http.File, error) {
	for seg := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(seg, ".") {
			return nil, fs.ErrNotExist
		}
	}
	f, err := n.fs.Open(name)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi.IsDir() {
		f.Close()
		return nil, fs.ErrNotExist
	}
	return f, nil
}

// safeJoin prevents `..` escapes via crafted keys (e.g., "../../etc/passwd").
func safeJoin(root, key string) (string, error) {
	if key == "" || strings.Contains(key, "..") {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(root, filepath.FromSlash(key)), nil
}
