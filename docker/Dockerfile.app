# syntax=docker/dockerfile:1
# Dockerfile for the Next.js web app.
# Builds from the monorepo root so pnpm workspaces resolve correctly.
# Uses BuildKit cache mounts for fast rebuilds:
#   - pnpm store cache  → skips re-downloading unchanged packages
#   - Next.js .next/cache → incremental compilation on source-only changes
FROM node:22-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifests first — changes here bust the install cache, source changes don't.
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/agent/package.json ./apps/agent/
# Copy lockfile if present (gitignored but improves reproducibility in CI)
COPY pnpm-lock.yam[l] ./

# Cache the pnpm content-addressable store across builds.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# Build stage
FROM base AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules

# Copy only what the web build needs — not all apps.
# next.config.ts already contains output:standalone so no mutation needed.
COPY package.json pnpm-workspace.yaml turbo.json ./
COPY apps/web ./apps/web
COPY apps/agent/package.json ./apps/agent/package.json

ENV NODE_OPTIONS="--max-old-space-size=4096"
# Cache Next.js incremental build output across rebuilds.
# On a source-only change this typically cuts build time by 60-80%.
RUN --mount=type=cache,id=nextjs-cache,target=/app/apps/web/.next/cache \
    pnpm --filter web build

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
