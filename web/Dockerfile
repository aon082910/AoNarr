FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx's official image auto-renders anything in /etc/nginx/templates/*.template through
# envsubst into /etc/nginx/conf.d/ at startup — lets the backend host/port be overridden per
# deployment (e.g. a standalone Unraid install where the two containers aren't docker-compose
# service-name-resolvable) without a custom entrypoint script.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV AONARR_SERVER_HOST=aonarr-server
ENV AONARR_SERVER_PORT=8989
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7878/ || exit 1
