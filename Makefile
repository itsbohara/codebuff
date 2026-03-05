# Codebuff Development Makefile
# Quick commands for local development

.PHONY: dev down db cli services sdk-build kill-ports studio help

# Read ports from .env.local if it exists, otherwise use defaults
PORT := $(shell grep -E '^PORT=' .env.local 2>/dev/null | cut -d'=' -f2 || echo 4242)
WEB_PORT := $(shell grep -E '^NEXT_PUBLIC_WEB_PORT=' .env.local 2>/dev/null | cut -d'=' -f2 || echo 3000)

## Kill processes using the configured ports
kill-ports:
	@echo "Killing processes on ports $(PORT) and $(WEB_PORT)..."
	@lsof -ti:$(PORT) 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -ti:$(WEB_PORT) 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
	@echo "Ports cleared"

## Start web dev server with database (recommended for web development)
dev: kill-ports
	@echo "Starting database..."
	bun start-db
	@echo "Starting web dev server on port $(WEB_PORT)..."
	cd web && PORT=$(WEB_PORT) bun dev

## Start all background services (db, sdk build, studio)
services: kill-ports
	bun up

## Stop all background services
down:
	bun down

## Start only the database
db: kill-ports
	bun start-db

## Start only the CLI (after services are running)
cli:
	bun start-cli

## Build the SDK
sdk-build:
	bun --cwd sdk build

## Start Drizzle Studio for database inspection
studio:
	bun --cwd packages/internal db:studio

## Show help
help:
	@echo "Available commands:"
	@echo "  make dev        - Kill ports, start database + web dev server"
	@echo "  make services   - Kill ports, start all background services (bun up)"
	@echo "  make down       - Stop all background services"
	@echo "  make db         - Kill ports, start only the database"
	@echo "  make cli        - Start only the CLI (after services are running)"
	@echo "  make studio     - Start Drizzle Studio for DB inspection"
	@echo "  make sdk-build  - Build the SDK"
	@echo "  make kill-ports - Kill processes on configured ports"
	@echo ""
	@echo "Configured ports (from .env.local):"
	@echo "  Internal API: $(PORT)"
	@echo "  Web app:      $(WEB_PORT)"
