# Node 24 (LTS). node:sqlite runs unflagged since Node 22.13 / 23.4, so no flag
# is needed. We run TypeScript directly via tsx (no build step) — this keeps the
# dashboard static-file path and node:sqlite working exactly as in local dev.
FROM node:24-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# App source (see .dockerignore — node_modules, .env, and data are excluded).
COPY . .

# SQLite data dir (also mounted as a named volume in docker-compose).
RUN mkdir -p /app/data
ENV DATABASE_URL=/app/data/safety-layer.db
# Bind to all interfaces so the container is reachable from the host / peers.
ENV HOST=0.0.0.0

EXPOSE 3000 4021

# Default: the backend + dashboard. docker-compose overrides `command` for the
# mock seller and the agent-sim.
CMD ["npx", "tsx", "src/index.ts"]
