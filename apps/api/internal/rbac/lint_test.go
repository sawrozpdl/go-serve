package rbac

import (
	"crypto/sha256"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestManifestInSyncWithPackage asserts the Go-embedded copy of
// permissions.json is byte-identical to the canonical source at
// packages/rbac/permissions.json. Regenerate with `go generate
// ./internal/rbac/...` after editing the canonical file.
func TestManifestInSyncWithPackage(t *testing.T) {
	const upstream = "../../../../packages/rbac/permissions.json"
	const local = "permissions.json"
	a, err := os.ReadFile(upstream)
	if err != nil {
		t.Fatalf("read upstream manifest: %v", err)
	}
	b, err := os.ReadFile(local)
	if err != nil {
		t.Fatalf("read local manifest: %v", err)
	}
	if sha256.Sum256(a) != sha256.Sum256(b) {
		t.Fatalf("manifest copy at %s is out of sync with %s — run `go generate ./internal/rbac/...`", local, upstream)
	}
}

// TestAuthHasPermissionStringsAreKnown walks the entire api package and
// asserts every string literal passed as the second argument to
// auth.HasPermission(...) (and auth.HasAnyPermission) is a real key in
// the manifest. This catches typos at test time so they never make it
// to runtime.
func TestAuthHasPermissionStringsAreKnown(t *testing.T) {
	root := "../api"
	fset := token.NewFileSet()
	var bad []string

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "auth" {
				return true
			}
			if sel.Sel.Name != "HasPermission" && sel.Sel.Name != "HasAnyPermission" {
				return true
			}
			for _, arg := range call.Args[1:] {
				lit, ok := arg.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				unq, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}
				if err := M.ValidateGrant(unq); err != nil {
					pos := fset.Position(lit.Pos())
					bad = append(bad, pos.String()+": "+sel.Sel.Name+"(_, "+lit.Value+") — "+err.Error())
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk api package: %v", err)
	}
	if len(bad) > 0 {
		t.Fatalf("found %d bad permission key(s) in auth.HasPermission calls:\n  %s", len(bad), strings.Join(bad, "\n  "))
	}
}
