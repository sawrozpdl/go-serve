package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type LocalStore struct {
	root          string
	publicURLBase string
}

func NewLocal(rootDir, publicURLBase string) (*LocalStore, error) {
	if rootDir == "" {
		return nil, errors.New("storage: local rootDir required")
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, fmt.Errorf("storage: mkdir %q: %w", rootDir, err)
	}
	return &LocalStore{
		root:          rootDir,
		publicURLBase: strings.TrimRight(publicURLBase, "/"),
	}, nil
}

func (s *LocalStore) Put(_ context.Context, key string, r io.Reader, _ PutOpts) (string, error) {
	clean, err := safeJoin(s.root, key)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
		return "", fmt.Errorf("storage: mkdir: %w", err)
	}
	f, err := os.Create(clean)
	if err != nil {
		return "", fmt.Errorf("storage: create: %w", err)
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return "", fmt.Errorf("storage: write: %w", err)
	}
	return s.publicURLBase + "/" + key, nil
}

func (s *LocalStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	clean, err := safeJoin(s.root, key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(clean)
	if err != nil {
		return nil, fmt.Errorf("storage: open: %w", err)
	}
	return f, nil
}

func (s *LocalStore) Delete(_ context.Context, key string) error {
	clean, err := safeJoin(s.root, key)
	if err != nil {
		return err
	}
	if err := os.Remove(clean); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("storage: delete: %w", err)
	}
	return nil
}

// safeJoin prevents `..` escapes via crafted keys (e.g., "../../etc/passwd").
func safeJoin(root, key string) (string, error) {
	if key == "" || strings.Contains(key, "..") {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(root, filepath.FromSlash(key)), nil
}
