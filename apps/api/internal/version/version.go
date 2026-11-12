// Package version identifies the running build of Go Serve.
//
// IRD lists billing software by name AND version (procedure 2082 §3(घ)): a
// version change needs an updated security test report on the Taxpayer
// Portal, so the version has to be visible wherever IRD looks — /healthz, /me,
// the web footer and the footer of every printed invoice.
//
// The release version lives in the VERSION file next to this one (embedded at
// build time, bumped by hand per docs/ird/RELEASES.md). The commit comes from
// the VCS stamp `go build` embeds automatically; no ldflags needed.
package version

import (
	_ "embed"
	"runtime/debug"
	"strings"
	"sync"
)

// Product is the software name as listed with IRD.
const Product = "Go Serve"

//go:embed VERSION
var raw string

// Version is the release version, e.g. "1.0.0".
var Version = strings.TrimSpace(raw)

var (
	commitOnce sync.Once
	commit     string
	dirty      bool
)

func readVCS() {
	commitOnce.Do(func() {
		info, ok := debug.ReadBuildInfo()
		if !ok {
			return
		}
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				commit = s.Value
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
	})
}

// Commit returns the short git commit the binary was built from ("" if the
// build carries no VCS stamp, e.g. `go test`), with "+dirty" when built from a
// modified tree.
func Commit() string {
	readVCS()
	c := commit
	if len(c) > 12 {
		c = c[:12]
	}
	if c != "" && dirty {
		c += "+dirty"
	}
	return c
}

// String is the human form printed on invoices: "Go Serve 1.0.0".
func String() string { return Product + " " + Version }
