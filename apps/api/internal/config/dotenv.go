package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// loadDotEnv looks for a `.env` file by walking up from the working directory
// and seeds os.Setenv for any keys that are not already set in the environment.
//
// Behavior:
//   - Skipped entirely when APP_ENV=prod. Production deploys must inject env
//     via the platform (App Runner, ECS task definition, Kubernetes Secret,
//     systemd EnvironmentFile, etc.); never via a checked-in or copied file.
//   - Existing env always wins. Values in `.env` only fill gaps. This means
//     the same binary works in dev (file-driven) and in prod (env-driven)
//     with no code branches.
//   - Walks up at most 6 levels so a stray `.env` somewhere far up the tree
//     doesn't get pulled in unexpectedly. Stops at the first match.
//
// The loader is intentionally minimal: it understands `KEY=VALUE`, strips one
// pair of surrounding single or double quotes, and skips blank lines and `#`
// comments. It does not handle multiline values, variable interpolation, or
// `export ` prefixes — keep `.env` files simple, or use a real shell.
func loadDotEnv() {
	if strings.EqualFold(os.Getenv("APP_ENV"), "prod") {
		return
	}
	path, ok := findDotEnv()
	if !ok {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if len(val) >= 2 {
			first, last := val[0], val[len(val)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, val)
	}
}

func findDotEnv() (string, bool) {
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for i := 0; i < 6; i++ {
		p := filepath.Join(dir, ".env")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
	return "", false
}
