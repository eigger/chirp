# chirp — 단일 이미지 (서버 + 웹 정적 파일 + smartmontools)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runner
RUN apk add --no-cache smartmontools
WORKDIR /app
ENV NODE_ENV=production \
    CHIRP_PORT=80 \
    CHIRP_DATA_DIR=/var/lib/chirp \
    CHIRP_WEB_DIR=/app/apps/web/dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /var/lib/chirp
VOLUME /var/lib/chirp
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${CHIRP_PORT}/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
