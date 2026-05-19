# syntax=docker/dockerfile:1.7
#
# OpenClaw gateway + bundled plugins (gapo-agent, bb-pm-tools, browser-tools).
#
# Image layout
#   /usr/local/lib/node_modules/openclaw  — global OpenClaw CLI
#   /opt/plugins/bb-pm-tools              — built bb-pm-tools plugin source
#   /opt/plugins/gapo-agent               — built gapo-agent plugin source
#   /opt/plugins/browser-tools            — built browser-tools plugin source
#   /root/.openclaw                       — runtime state (mount as volume)
#
# First start: entrypoint links the bundled plugins into /root/.openclaw/extensions
# the same way `openclaw plugins install --link` would on a dev host, then
# execs `openclaw gateway run`.
# -----------------------------------------------------------------------------

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Stage 1: shared base ─────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl python3 make g++ psmisc \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── Stage 2: build bb-pm-tools ───────────────────────────────────────────────
FROM base AS build-bb-pm-tools
WORKDIR /build
COPY bb-pm-tools/package.json bb-pm-tools/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY bb-pm-tools/openclaw.plugin.json bb-pm-tools/tsconfig.json ./
COPY bb-pm-tools/src ./src
RUN pnpm exec tsc && pnpm prune --prod

# ── Stage 3: build gapo-agent ────────────────────────────────────────────────
FROM base AS build-gapo-agent
WORKDIR /build
COPY gapo-agent/package.json gapo-agent/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY gapo-agent/openclaw.plugin.json gapo-agent/tsconfig.json ./
COPY gapo-agent/src ./src
RUN pnpm exec tsc && rm -rf node_modules

# ── Stage 4: build browser-tools ─────────────────────────────────────────────
FROM base AS build-browser-tools
WORKDIR /build
COPY browser-tools/package.json browser-tools/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY browser-tools/openclaw.plugin.json browser-tools/tsconfig.json ./
COPY browser-tools/src ./src
RUN pnpm exec tsc && pnpm prune --prod

# ── Stage 5: runtime ─────────────────────────────────────────────────────────
FROM base AS runtime

ARG OPENCLAW_VERSION=2026.4.12
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Copy built plugins (source layout — OpenClaw installs via `--link`).
COPY --from=build-bb-pm-tools /build /opt/plugins/bb-pm-tools
COPY --from=build-gapo-agent /build /opt/plugins/gapo-agent
COPY --from=build-browser-tools /build /opt/plugins/browser-tools
RUN cd /opt/plugins/browser-tools && npx playwright install --with-deps chromium

# Runtime state dir (will be overlaid by named volume in compose).
RUN mkdir -p /root/.openclaw/extensions /root/.openclaw/plugins

COPY docker/openclaw/entrypoint.sh /usr/local/bin/openclaw-entrypoint
RUN chmod +x /usr/local/bin/openclaw-entrypoint

EXPOSE 18789
ENV HOME=/root \
    NODE_ENV=production \
    OPENCLAW_GATEWAY_PORT=18789

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint"]
CMD ["openclaw", "gateway", "run", "--bind", "lan", "--port", "18789", "--force"]
