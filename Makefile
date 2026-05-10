SHELL := /bin/bash
.DEFAULT_GOAL := help

# Load .env if present (non-fatal). The `export` makes every loaded key
# visible to recipe shells, so `make migrate` can read DATABASE_URL.
-include .env
export

COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env

.PHONY: help
help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: env
env: ## Create .env from .env.example if missing.
	@test -f .env || (cp .env.example .env && echo "Created .env — fill in secrets.")

.PHONY: install
install: env ## Install JS deps (pnpm) and Go modules.
	pnpm install
	cd apps/api && go mod download

# ---------------------------------------------------------------------------
# Database migrations — pure Go, no Docker. Uses DATABASE_URL from .env.
# Run these against any Postgres: host install, docker compose, RDS, Neon.
# ---------------------------------------------------------------------------

.PHONY: migrate
migrate: ## Apply pending migrations against DATABASE_URL.
	cd apps/api && go run ./cmd/migrate up

.PHONY: migrate-status
migrate-status: ## Show migration status.
	cd apps/api && go run ./cmd/migrate status

.PHONY: migrate-down
migrate-down: ## Roll back one migration.
	cd apps/api && go run ./cmd/migrate down

.PHONY: migrate-reset
migrate-reset: ## Roll back ALL migrations (destructive).
	cd apps/api && go run ./cmd/migrate reset

.PHONY: seed
seed: ## Seed two demo tenants (sahan, brews) with test users.
	cd apps/api && go run ./cmd/seed

# ---------------------------------------------------------------------------
# Host dev runners — run API and web directly on the host. Assumes you
# have a Postgres reachable at DATABASE_URL (host install, RDS, or
# `make compose-up postgres` for a quick dockerized DB).
# ---------------------------------------------------------------------------

.PHONY: api-dev
api-dev: ## Run the API on the host (reads .env via the bundled loader).
	cd apps/api && go run ./cmd/server

.PHONY: api-watch
api-watch: ## Run the API with air hot reload (install: go install github.com/air-verse/air@latest).
	cd apps/api && air

.PHONY: web-dev
web-dev: ## Run the web dev server on the host.
	pnpm --filter @cafe-mgmt/web dev

# ---------------------------------------------------------------------------
# Build / test / lint — all host-only.
# ---------------------------------------------------------------------------

.PHONY: build
build: ## Build all apps (Go API + web).
	cd apps/api && CGO_ENABLED=0 go build -trimpath -o bin/server ./cmd/server
	pnpm --filter @cafe-mgmt/web build

.PHONY: test
test: ## Run all tests (Go + JS).
	cd apps/api && go test ./... -race -count=1
	pnpm test

.PHONY: lint
lint: ## Lint everything.
	cd apps/api && go vet ./...
	pnpm lint

.PHONY: typecheck
typecheck: ## TypeScript typecheck across the monorepo.
	pnpm typecheck

.PHONY: format
format: ## Format JS/TS via prettier.
	pnpm format

# ---------------------------------------------------------------------------
# Docker compose — explicit "compose-*" prefix so they cannot accidentally
# fire when running adjacent commands (e.g. `make migrate up` once made
# the docker stack come up alongside the migration).
# ---------------------------------------------------------------------------

.PHONY: compose-up
compose-up: env ## docker compose up: postgres + api containers.
	$(COMPOSE) up -d --build postgres api

.PHONY: compose-db
compose-db: env ## docker compose up: postgres only (handy for host-run API).
	$(COMPOSE) up -d postgres

.PHONY: compose-down
compose-down: ## docker compose down (preserves volumes).
	$(COMPOSE) down

.PHONY: compose-logs
compose-logs: ## Tail docker compose logs.
	$(COMPOSE) logs -f --tail=100

.PHONY: compose-psql
compose-psql: ## psql into the dockerized DB.
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-cafe} -d $${POSTGRES_DB:-cafe}

.PHONY: compose-clean
compose-clean: ## Stop containers and wipe volumes (destructive).
	$(COMPOSE) down -v
	rm -rf infra/.volumes apps/api/bin apps/web/dist
