# syntax=docker/dockerfile:1.7
#
# OpenClaw gateway + bundled plugins (gapo-work, bb-pm-tools).
#
# Image layout
#   /usr/local/lib/node_modules/openclaw  — global OpenClaw CLI
#   /opt/plugins/bb-pm-tools              — built bb-pm-tools plugin source
#   /opt/plugins/gapo-work                — built gapo-work plugin source
#   /root/.openclaw                       — runtime state (mount as volume)
#
# First start: entrypoint links the two plugins into /root/.openclaw/extensions
# the same way `openclaw plugins install --link` would on a dev host, then
# execs `openclaw gateway run`.
# -----------------------------------------------------------------------------

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Stage 1: shared base ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── Stage 2: build bb-pm-tools ───────────────────────────────────────────────
FROM base AS build-bb-pm-tools
WORKDIR /build
COPY bb-pm-tools/package.json bb-pm-tools/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY bb-pm-tools/tsconfig.json ./
COPY bb-pm-tools/src ./src
RUN pnpm exec tsc && pnpm prune --prod

# ── Stage 3: build gapo-work ─────────────────────────────────────────────────
FROM base AS build-gapo-work
WORKDIR /build
COPY openclaw/openclaw/plugins/gapo-work/package.json \
     openclaw/openclaw/plugins/gapo-work/package-lock.json ./
RUN npm install
COPY openclaw/openclaw/plugins/gapo-work/tsconfig.json ./
COPY openclaw/openclaw/plugins/gapo-work/*.ts ./
RUN ./node_modules/.bin/tsc && npm prune --omit=dev

# ── Stage 4: runtime ─────────────────────────────────────────────────────────
FROM base AS runtime

ARG OPENCLAW_VERSION=2026.4.12
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Copy built plugins (source layout — OpenClaw installs via `--link`).
COPY --from=build-bb-pm-tools /build /opt/plugins/bb-pm-tools
COPY --from=build-gapo-work  /build /opt/plugins/gapo-work

# Runtime state dir (will be overlaid by named volume in compose).
RUN mkdir -p /root/.openclaw/extensions /root/.openclaw/plugins

COPY docker/openclaw/entrypoint.sh /usr/local/bin/openclaw-entrypoint
RUN chmod +x /usr/local/bin/openclaw-entrypoint

EXPOSE 18789
ENV HOME=/root \
    NODE_ENV=production \
    OPENCLAW_GATEWAY_PORT=18789

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint"]
CMD ["openclaw", "gateway", "run", "--bind", "0.0.0.0", "--port", "18789", "--force"]
