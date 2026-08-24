FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN cp src/db/schema.sql dist/db/schema.sql && cp src/db/schema.postgres.sql dist/db/schema.postgres.sql

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl ffmpeg gnupg \
    && rm -rf /var/lib/apt/lists/*
# postgresql-client from Debian bookworm is v15, which refuses to pg_dump a newer (16/17) server —
# pulling the latest client from PGDG's own repo instead, since a newer pg_dump can dump any older
# server but not vice versa.
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp is fetched as a standalone binary (not via pip) to avoid pulling in a whole Python
# packaging toolchain just for one tool — used by the "ytdlp" download client type.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp
ARG BUILD_TIME=""
ENV NODE_ENV=production
ENV AONARR_CONFIG_DIR=/config
ENV AONARR_BUILD_TIME=$BUILD_TIME
ENV AONARR_IMAGE_TAG=server
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY CHANGELOG.md ./

VOLUME ["/config"]
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8989/api/health || exit 1
CMD ["node", "dist/index.js"]
