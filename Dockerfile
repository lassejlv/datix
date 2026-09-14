FROM oven/bun:1.4.2 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile
COPY web ./web
COPY config/legal.json ./config/legal.json
COPY polar-catalog.json ./polar-catalog.json
RUN bun run --cwd web build

FROM rust:1.98.1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY polar-catalog.json ./polar-catalog.json
COPY web/public/openapi.json ./web/public/openapi.json
COPY config/legal.json ./config/legal.json
COPY web/src/content/legal ./web/src/content/legal
RUN cargo build --release --locked -p datix-api -p datix-db

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PORT=8080 SERVICE_ROLE=combined
COPY --from=backend --chown=10001:10001 /app/target/release/datix-api /app/datix-api
COPY --from=backend --chown=10001:10001 /app/target/release/datix-db /app/datix-db
COPY --from=web --chown=10001:10001 /app/web/dist/client /app/web/dist/client
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl --fail --silent "http://127.0.0.1:${PORT}/health/ready" > /dev/null || exit 1
CMD ["/usr/bin/env", "-u", "DATABASE_URL_UNPOOLED", "/app/datix-api"]
