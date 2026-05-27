package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"log/slog"

	"github.com/pewssh/cafe-mgmt/api/internal/auth"
	"github.com/pewssh/cafe-mgmt/api/internal/config"
	"github.com/pewssh/cafe-mgmt/api/internal/db"
	"github.com/pewssh/cafe-mgmt/api/internal/httpx"
	"github.com/pewssh/cafe-mgmt/api/internal/logging"
	"github.com/pewssh/cafe-mgmt/api/internal/mail"
	"github.com/pewssh/cafe-mgmt/api/internal/realtime"
	"github.com/pewssh/cafe-mgmt/api/internal/storage"
)

func main() {
	// Bootstrap logger — used only until config is loaded so we can pick
	// the real format/level based on env.
	bootstrap := logging.New("dev", "info", "")
	slog.SetDefault(bootstrap)

	cfg, err := config.Load()
	if err != nil {
		bootstrap.Error("config load failed", "err", err)
		os.Exit(1)
	}

	logger := logging.New(cfg.Env, cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)
	auth.SetTokenConfig(cfg.SessionSecret, cfg.AccessTokenTTL, cfg.RefreshTokenTTL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("db open failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	hub := realtime.New(logger)

	store, err := buildStorage(ctx, cfg.Storage)
	if err != nil {
		logger.Error("storage init failed", "err", err)
		os.Exit(1)
	}

	mailer := mail.New(mail.Config{
		Host:     cfg.Mail.Host,
		Port:     cfg.Mail.Port,
		Username: cfg.Mail.Username,
		Password: cfg.Mail.Password,
		From:     cfg.Mail.From,
		FromName: cfg.Mail.FromName,
	})
	if mailer == nil {
		logger.Info("mail relay disabled — set SENDGRID_API_KEY + MAIL_FROM to enable shift-end emails")
	} else {
		logger.Info("mail relay configured", "host", cfg.Mail.Host, "from", cfg.Mail.From)
	}

	router := httpx.NewRouter(cfg, logger, pool, hub, store, mailer)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		logger.Info("api listening", "addr", cfg.HTTPAddr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server crashed", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logger.Info("shutdown signal received")

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		logger.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	logger.Info("server stopped")
}

func buildStorage(ctx context.Context, c config.StorageConfig) (storage.Storage, error) {
	switch c.Driver {
	case "s3":
		return storage.NewS3(ctx, storage.S3Config{
			Endpoint:        c.S3Endpoint,
			Region:          c.S3Region,
			Bucket:          c.S3Bucket,
			AccessKeyID:     c.S3AccessKeyID,
			SecretAccessKey: c.S3SecretAccessKey,
			PublicURLBase:   c.S3PublicURLBase,
			ForcePathStyle:  c.S3ForcePathStyle,
		})
	default:
		return storage.NewLocal(c.LocalRoot, c.LocalPublicBase)
	}
}
