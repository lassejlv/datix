FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY vite.config.ts tsconfig.base.json ./
RUN bun run build

FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
RUN bun install --frozen-lockfile --production --filter @datix/api --filter @datix/database

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dependencies --chown=bun:bun /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=dependencies --chown=bun:bun /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=build --chown=bun:bun /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=bun:bun /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=bun:bun /app/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=bun:bun /app/packages/database/src ./packages/database/src
COPY --from=build --chown=bun:bun /app/packages/database/migrations ./packages/database/migrations
COPY --from=build --chown=bun:bun /app/config ./config
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`);process.exit(r.ok?0:1)'
CMD ["bun", "apps/api/dist/main.js"]
