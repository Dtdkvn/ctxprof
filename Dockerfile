# syntax=docker/dockerfile:1.7
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=ctxprof_ca,required=false \
    if [ -f /run/secrets/ctxprof_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/ctxprof_ca npm ci --ignore-scripts --no-audit --no-fund; \
    else \
      npm ci --ignore-scripts --no-audit --no-fund; \
    fi
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/postbuild.mjs ./scripts/postbuild.mjs
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime
ENV NODE_ENV=production \
    CTXPROF_DATA=/data \
    CTXPROF_HOST=0.0.0.0 \
    CTXPROF_PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
RUN find /app/dist -type f \( -name '*.map' -o -name '*.d.ts' \) -delete \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn* \
    && mkdir /data \
    && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["proxy", "--host", "0.0.0.0", "--port", "8787", "--allow-remote", "--data", "/data"]
