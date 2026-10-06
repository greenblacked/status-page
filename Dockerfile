# Self-hosting image: the production build behind the Node server in
# src/node/serve.ts. Published as ghcr.io/greenblacked/status-page by
# release.yml (linux/amd64 and linux/arm64, signed with cosign).
#
#   docker build -t status-page .
#   docker run --rm -p 3000:3000 status-page
#
# Build argument VITE_STATUS_HISTORY=1 adds the uptime-history strip to the
# board; it is read at build time (README, "Uptime history").
#
# The final stage holds the build output, the production dependencies and
# the server, owned by root and run as the unprivileged `node` user, so
# `--read-only` and `--cap-drop ALL` work as they are. Nothing is written to
# disk at run time.

# Node 22.22.2 (.nvmrc) on Debian 12, by the digest of the multi-platform
# index, so amd64 and arm64 both resolve from it. Dependabot moves the tag and
# the digest together (.github/dependabot.yml): keep the digest the same in
# both FROM lines.
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS base

# The build runs on the machine that runs `docker build`, whatever platform the
# image is for: dist/ is JavaScript, CSS and assets, the same for every
# platform, so an arm64 image built on amd64 does not run the bundler under
# emulation.
FROM --platform=$BUILDPLATFORM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build-base

# Production dependencies only, for the image's own platform: what
# dist/server/server.js and src/node import when they run. pnpm is the version
# and hash package.json pins: Corepack downloads exactly that and refuses it if
# the sha512 differs (scripts/ci/pnpm-pin.sh). The lockfile is installed as it
# is, or the build fails.
FROM base AS prod-deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod --ignore-scripts

# Every dependency, then the production build into dist/.
FROM build-base AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
ARG VITE_STATUS_HISTORY=
ENV VITE_STATUS_HISTORY=${VITE_STATUS_HISTORY}
RUN pnpm run build

FROM base AS runtime
LABEL org.opencontainers.image.title="Status Page" \
      org.opencontainers.image.description="One status board for the services you depend on, read from each vendor's own official source" \
      org.opencontainers.image.source="https://github.com/greenblacked/status-page" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/node ./src/node
COPY src/lib/security-headers.ts ./src/lib/security-headers.ts
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
# /healthz answers from the process alone, never from a vendor, so a slow
# vendor cannot make the container unhealthy. Node is already here, curl is not.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/node/serve.ts"]
