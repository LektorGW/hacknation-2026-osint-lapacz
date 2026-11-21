# syntax=docker/dockerfile:1
# OŁCyŚ — obraz produkcyjny: API + zbudowany interfejs na jednym porcie (4000), opcjonalnie piaskownica w tym samym kontenerze.
# Budowa:      docker build -t olcys .
# Uruchomienie: docker compose up -d   (zob. docker-compose.yml i docs/WDROZENIE.md)

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.21.0

# ---------- Wspólna baza: Node + pnpm ----------
FROM node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
# corepack (dołączony do Node 24) pobiera wskazaną wersję pnpm; npm jako zapasowa droga, gdy corepack jest niedostępny.
RUN (corepack enable --install-directory /usr/local/bin && corepack prepare "pnpm@${PNPM_VERSION}" --activate) \
    || npm install -g "pnpm@${PNPM_VERSION}"; \
    pnpm --version
WORKDIR /app

# Manifesty wszystkich pakietów obszaru roboczego — plik blokady musi się z nimi zgadzać (--frozen-lockfile).
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/sources/package.json packages/sources/
COPY packages/chain/package.json packages/chain/
COPY packages/ai/package.json packages/ai/
COPY apps/api/package.json apps/api/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/web/package.json apps/web/
COPY apps/identity-lab/package.json apps/identity-lab/

# ---------- Budowa interfejsu (apps/web/dist) ----------
FROM manifests AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @olcys/web build

# ---------- Zależności produkcyjne (bez Vite, React do budowy itp.) ----------
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store \
      --filter "@olcys/api..." --filter "@olcys/sandbox..."

# ---------- Obraz wykonawczy ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    NO_COLOR=1 \
    OLCYS_IN_CONTAINER=1 \
    OLCYS_SERVE_WEB=1 \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    SANDBOX_HOST=0.0.0.0 \
    SANDBOX_PORT=4100 \
    OLCYS_DATA_DIR=/data/pg \
    OLCYS_BACKUP_DIR=/data/kopie
WORKDIR /app
# node_modules (z dowiązaniami pnpm) z etapu deps, potem kod źródłowy — Node 24 uruchamia TypeScript bez kompilacji.
COPY --from=deps /app ./
COPY package.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/sandbox apps/sandbox
COPY scripts scripts
COPY --from=build /app/apps/web/dist apps/web/dist
# Katalog danych i pamięć podręczna kursów walut należą do użytkownika bez uprawnień administratora (node, UID 1000);
# reszta /app pozostaje tylko do odczytu dla procesu.
RUN mkdir -p /data /app/packages/chain/data/cache && chown -R node:node /data /app/packages/chain/data/cache
USER node
VOLUME ["/data"]
EXPOSE 4000 4100
# SIGTERM → skrypt uruchomieniowy zamyka API łagodnie (migawka bazy), potem piaskownicę. Daj mu czas: stop_grace_period w compose.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "scripts/run.ts", "start"]
