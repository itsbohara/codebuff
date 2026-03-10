# Codebuff PM2 Management Makefile
# Usage: make <command>

.PHONY: help pm2-start pm2-stop pm2-restart pm2-logs pm2-status pm2-delete pm2-build

# Default target
help:
	@echo "Codebuff PM2 Management Commands:"
	@echo "  make pm2-build    - Build the web app for production"
	@echo "  make pm2-start    - Start Codebuff web with PM2 on port 6009"
	@echo "  make pm2-stop     - Stop Codebuff web"
	@echo "  make pm2-restart  - Restart Codebuff web"
	@echo "  make pm2-logs     - Show PM2 logs for Codebuff"
	@echo "  make pm2-status   - Show PM2 process status"
	@echo "  make pm2-delete   - Remove Codebuff from PM2"

# Build the web app
pm2-build:
	cd web && bun run build

# Start Codebuff web with PM2 (port 6009)
pm2-start:
	cd web && PORT=6009 pm2 start "bun run start" --name codebuff-web

# Stop Codebuff web
pm2-stop:
	pm2 stop codebuff-web

# Restart Codebuff web
pm2-restart:
	pm2 restart codebuff-web

# Show logs
pm2-logs:
	pm2 logs codebuff-web

# Show status
pm2-status:
	pm2 status

# Delete from PM2
pm2-delete:
	pm2 delete codebuff-web
