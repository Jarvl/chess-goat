# syntax=docker/dockerfile:1.7
# Spec §4.4: multi-stage — build the Mini App, then a runtime image with the server and the bundle.
FROM node:26-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# A shared cache, not root's home: the runtime runs as `node`, which must find this pnpm already
# prepared (for `pnpm run refund-tip`) instead of downloading it on first use.
ENV COREPACK_HOME=/corepack
# Node 25+ no longer bundles corepack, so install a pinned copy from npm first.
RUN npm install -g corepack@0.36.0 \
    && corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
ENV CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/miniapp/package.json apps/miniapp/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm --filter @chess-goat/miniapp build && node scripts/check-bundle-size.mjs

# Snapshot spec §2.2: the card's fonts are downloaded by pinned URL and sha256, never committed.
FROM base AS fonts
COPY scripts/fetch-fonts.mjs ./scripts/
RUN node scripts/fetch-fonts.mjs

FROM base AS runtime
ENV NODE_ENV=production
# Spec §12: the engine opponent needs a UCI binary. Pin the version, and prove at build time that it
# answers our adapter with a legal move — a broken or netless binary must fail here, not in
# production. Stockfish is GPL-3.0, compatible with this repository's GPL-3.0-or-later (see
# scripts/check-licences.mjs, which cannot see this non-npm dependency itself). Debian installs the
# binary under /usr/games, which is not on the default PATH, so it is added here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish=15.1-4 \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=$PATH:/usr/games
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml LICENSE ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY --from=fonts /app/apps/server/fonts/ ./apps/server/fonts/
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=1 pnpm install --frozen-lockfile --prod --filter "@chess-goat/server..." \
    && chown -R node:node /app
# Run the assertion against the binary that actually ships, with the adapter it actually ships
# with. `tsx` and `chess.js` are production dependencies of @chess-goat/server (see its
# package.json), so the `--prod` install above already has them; asserting here — not in the build
# stage — is the point: it proves the runtime image, not a different stage's copy.
RUN cd apps/server && node --import tsx ../../scripts/assert-engine.mjs
COPY --from=build --chown=node:node /app/apps/miniapp/dist ./apps/miniapp/dist
ENV MINI_APP_DIR=/app/apps/miniapp/dist
ENV PORT=3000
EXPOSE 3000
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node runs tsx directly: no pnpm (and no corepack download) at start, and SIGTERM reaches the
# process so the shutdown in index.ts runs.
CMD ["node", "--import", "tsx", "src/index.ts"]
