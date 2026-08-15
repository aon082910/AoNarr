FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN cp src/db/schema.sql dist/db/schema.sql

FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp is fetched as a standalone binary (not via pip) to avoid pulling in a whole Python
# packaging toolchain just for one tool — used by the "ytdlp" download client type.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp
ENV NODE_ENV=production
ENV AONARR_CONFIG_DIR=/config
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY CHANGELOG.md ./

VOLUME ["/config"]
EXPOSE 8989
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8989/api/health || exit 1
CMD ["node", "dist/index.js"]
