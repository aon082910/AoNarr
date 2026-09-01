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
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip make g++ ca-certificates curl ffmpeg gnupg \
    && rm -rf /var/lib/apt/lists/*
# ffsubsync re-aligns a downloaded subtitle's timing against the video's own audio (voice-activity
# detection, no external API) — used as a best-effort pass on subtitles the picker didn't already
# consider a high-confidence match (see subtitleSync.ts). --break-system-packages is required on
# Debian bookworm's externally-managed system Python; acceptable here since this container has no
# other Python workload to conflict with.
RUN pip install --no-cache-dir --break-system-packages ffsubsync
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
# gosu lets the entrypoint start as root (needed to chown /config and create a matching
# user/group for PUID/PGID) and then drop the node process to that user before exec'ing it.
RUN GOSU_ARCH="$(dpkg --print-architecture)" \
    && curl -L "https://github.com/tianon/gosu/releases/download/1.17/gosu-${GOSU_ARCH}" -o /usr/local/bin/gosu \
    && chmod +x /usr/local/bin/gosu
ARG BUILD_TIME=""
ENV NODE_ENV=production
ENV AONARR_CONFIG_DIR=/config
ENV AONARR_BUILD_TIME=$BUILD_TIME
ENV AONARR_IMAGE_TAG=server
ENV PUID=99
ENV PGID=100
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY CHANGELOG.md ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/config"]
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8989/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
