# ---- build stage: compile native deps (better-sqlite3) ----
FROM node:26-trixie-slim AS build
WORKDIR /app

# Toolchain needed by node-gyp to build better-sqlite3
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage: slim image with prebuilt node_modules ----
FROM node:26-trixie-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src

# Data (SQLite db) lives here; mount a volume to persist it
RUN mkdir -p /app/data \
  && chown -R node:node /app/data

VOLUME ["/app/data"]

EXPOSE 7447

# Use the node user so we aren't running as root in container
USER node

CMD ["node", "src/index.js"]

LABEL org.opencontainers.image.description="A Nostr relay blaster specifically for gift wrapped DMs within your WoT"
LABEL org.opencontainers.image.source=https://github.com/xannythepleb/xannyblastr