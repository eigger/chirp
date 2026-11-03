# chirp: single image (server + web static files + smartmontools)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM deps AS build
RUN apk add --no-cache bash
COPY . .
RUN npm run build
RUN npm prune --omit=dev
# Same runtime tree as the release tarball, including nested workspace node_modules.
RUN bash scripts/package-release.sh /out

FROM node:24-alpine AS runner
RUN apk add --no-cache smartmontools
WORKDIR /app
ENV NODE_ENV=production \
    CHIRP_PORT=80 \
    CHIRP_DATA_DIR=/var/lib/chirp \
    CHIRP_WEB_DIR=/app/apps/web/dist
COPY --from=build /out/ ./
RUN mkdir -p /var/lib/chirp
VOLUME /var/lib/chirp
EXPOSE 80
# Probes the address CHIRP_HOST/CHIRP_PORT actually bind (loopback for 0.0.0.0/::).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "apps/server/dist/healthcheck.js"]
CMD ["node", "apps/server/dist/index.js"]
