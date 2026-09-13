FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
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
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
RUN bun install --frozen-lockfile --production --filter @datix/api --filter @datix/db --filter @datix/email

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dependencies --chown=bun:bun /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=dependencies --chown=bun:bun /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=dependencies --chown=bun:bun /app/packages/email/node_modules ./packages/email/node_modules
COPY --from=build --chown=bun:bun /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=bun:bun /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=bun:bun /app/packages/db/package.json ./packages/db/package.json
COPY --from=build --chown=bun:bun /app/packages/db/src ./packages/db/src
COPY --from=build --chown=bun:bun /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=bun:bun /app/packages/email/package.json ./packages/email/package.json
COPY --from=build --chown=bun:bun /app/packages/email/src ./packages/email/src
COPY --from=build --chown=bun:bun /app/packages/email/tsconfig.json ./packages/email/tsconfig.json
COPY --from=build --chown=bun:bun /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build --chown=bun:bun /app/config ./config
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD bun -e 'const r=await fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`);process.exit(r.ok?0:1)'
CMD ["bun", "apps/api/dist/main.js"]
