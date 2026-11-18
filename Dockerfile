# Hosted mode (Streamable HTTP + OAuth) for remote connectors such as claude.ai.
# The stdio package does not need this image.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# SQLite database with the encrypted Nextcloud credentials — mount a persistent volume here.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV NEXTCLOUD_MCP_DB_PATH=/data/nextcloud-mcp.sqlite \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/index.js", "--http"]
