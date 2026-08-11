# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/postbuild.mjs ./scripts/postbuild.mjs
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    CTXPROF_DATA=/data \
    CTXPROF_HOST=0.0.0.0 \
    CTXPROF_PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["proxy", "--host", "0.0.0.0", "--port", "8787", "--allow-remote", "--data", "/data"]
