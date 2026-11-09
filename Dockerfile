# Backend API image. The web application is built and served independently.
FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev --no-audit --no-fund

# TypeScript 7 uses a native compiler; build on glibc and ship only the emitted JS.
FROM node:22-bookworm-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.json

FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg tini libstdc++
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8088 \
    BANGUMI_ROOT=/media \
    HLS_CACHE_MAX_MB=1024 \
    NODE_OPTIONS=--max-old-space-size=280 \
    TRANSCODE_THREADS=2 \
    TRANSCODE_RC_LOOKAHEAD=10 \
    TRANSCODE_MUX_QUEUE=512
WORKDIR /app
COPY --from=deps /app/server ./server
COPY --from=build /app/server/dist ./server/dist
COPY server/db ./server/db
COPY server/config ./server/config
RUN mkdir -p /app/data /media && chown -R node:node /app/data
VOLUME ["/media", "/app/data"]
EXPOSE 8088
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8088/api/auth/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
