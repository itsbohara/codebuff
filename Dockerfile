# syntax=docker/dockerfile:1

# Build stage
FROM oven/bun:1.3.5 AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock bunfig.toml ./
COPY web/package.json ./web/
COPY common/package.json ./common/
COPY packages/internal/package.json ./packages/internal/
COPY packages/billing/package.json ./packages/billing/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY sdk/package.json ./sdk/
COPY .agents/package.json ./.agents/
COPY agents/package.json ./agents/
COPY cli/package.json ./cli/
COPY scripts/package.json ./scripts/

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Build the web app
RUN cd web && bun run build

# Production stage
FROM oven/bun:1.3.5-slim

WORKDIR /app

# Copy built application
COPY --from=builder /app/web/.next ./web/.next
COPY --from=builder /app/web/package.json ./web/
COPY --from=builder /app/web/public ./web/public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/node_modules ./web/node_modules
COPY --from=builder /app/common ./common
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/sdk ./sdk

WORKDIR /app/web

EXPOSE 3000 6009

ENV NODE_ENV=production
ENV PORT=3000

CMD ["bun", "run", "start"]
