// Migrate runs goose migrations against DATABASE_URL.
//
// Usage:
//
//	migrate up
//	migrate down
//	migrate status
//	migrate reset
//	migrate version
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/pewssh/cafe-mgmt/api/migrations"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: migrate <up|down|status|reset|version>")
		os.Exit(2)
	}
	cmd := os.Args[1]

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL not set")
		os.Exit(2)
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open db: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.PingContext(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "ping db: %v\n", err)
		os.Exit(1)
	}

	goose.SetBaseFS(migrations.FS)
	// Use goose's default stdout logger so `migrate up` prints which files
	// it applied (or "no migrations to run.") and `migrate status` prints
	// its standard table. Silencing it here previously made every command
	// look like a no-op even when it had work to do.
	if err := goose.SetDialect("postgres"); err != nil {
		fmt.Fprintf(os.Stderr, "dialect: %v\n", err)
		os.Exit(1)
	}

	switch cmd {
	case "up":
		err = goose.Up(db, ".")
	case "down":
		err = goose.Down(db, ".")
	case "status":
		err = goose.Status(db, ".")
	case "reset":
		err = goose.Reset(db, ".")
	case "version":
		var v int64
		v, err = goose.GetDBVersion(db)
		if err == nil {
			fmt.Println(v)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		os.Exit(2)
	}
	if err != nil {
		slog.Error("migration failed", "cmd", cmd, "err", err)
		os.Exit(1)
	}
}
