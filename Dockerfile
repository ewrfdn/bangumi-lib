# AniShare 镜像：多阶段构建（前端 → 后端依赖 → 运行时）
# ffmpeg 用系统包（含 libx264 / libx265 / libass / libdav1d），负责转码、媒体探测、字幕抽取

############################
# 1. 构建前端
############################
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN npm ci --no-audit --no-fund --workspace=anishare-web --include-workspace-root
COPY web ./web
RUN npm run build -w web

############################
# 2. 安装后端依赖（仅生产依赖）
############################
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
RUN npm ci --omit=dev --no-audit --no-fund --workspace=anishare-server --include-workspace-root

############################
# 3. 运行时
############################
FROM node:22-alpine AS runtime

RUN apk add --no-cache ffmpeg tini \
    && ffmpeg -hide_banner -version | head -1 \
    && ffprobe -hide_banner -version | head -1

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
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=web /app/web/dist ./web/dist

RUN mkdir -p /app/data /media && chown -R node:node /app/data
VOLUME ["/media"]
EXPOSE 8088
USER node

# tini 作为 init，保证 ffmpeg 子进程能被回收
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/src/index.js"]
