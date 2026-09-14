FROM oven/bun:1.4.2 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile
COPY web ./web
COPY config/polar-catalog.json ./config/polar-catalog.json
RUN bun run --cwd web build

FROM rust:1.98.1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY config ./config
RUN cargo build --release --locked -p datix-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PORT=8080 SERVICE_ROLE=combined
COPY --from=backend --chown=10001:10001 /app/target/release/datix-api /app/datix-api
COPY --from=web --chown=10001:10001 /app/web/dist/client /app/web/dist/client
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl --fail --silent "http://127.0.0.1:${PORT}/health/ready" > /dev/null || exit 1
CMD ["/app/datix-api"]
