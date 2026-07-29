# syntax=docker/dockerfile:1
# Pinning node:20-bookworm-slim
FROM node@sha256:b2c8e0eb8a6aeeae33b2711f8f516003e27ee45804e270468d937b3214f2f0cc AS base

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# Stage: Deps
FROM base AS deps
RUN npm ci --only=production

# Stage: Build
FROM base AS builder
RUN npm ci
COPY . .
RUN npm run build

# Stage: Runner
FROM node@sha256:b2c8e0eb8a6aeeae33b2711f8f516003e27ee45804e270468d937b3214f2f0cc AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only necessary files
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/package.json ./package.json

# Use non-root user
USER node

# Expose API port
EXPOSE 3001

CMD ["node", "dist/index.js"]