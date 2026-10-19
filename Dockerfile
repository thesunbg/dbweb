# dbweb as a hosted "DB studio" (embedded mode, see apps/server/src/services/embedded.ts).
# The local-first app does not need this file; it is for platforms that run
# dbweb next to their databases behind an authenticating proxy.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libsecret-1-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/adapters/package.json packages/adapters/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @dbweb/web run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DBWEB_EMBEDDED=1 \
    DBWEB_HOST=0.0.0.0 \
    DBWEB_PORT=4317 \
    DBWEB_DATA_DIR=/data \
    DBWEB_FILE_VAULT=1
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data
EXPOSE 4317
WORKDIR /app/apps/server
# tsx, not node dist/: @dbweb/adapters exports raw .ts (see CLAUDE.md).
CMD ["node", "--import", "tsx", "src/index.ts"]
