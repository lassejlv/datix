FROM oven/bun:1.4.2 AS frontend
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/vite.config.ts web/tsconfig.json web/index.html ./
COPY config/polar-catalog.json /app/config/polar-catalog.json
COPY web/src ./src
COPY web/public ./public
COPY web/scripts/build-tracker.ts web/scripts/build-vitals.ts ./scripts/
RUN bun run build

FROM rust:1.96-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY config ./config
COPY docs/database ./docs/database
RUN --mount=type=cache,id=s/a5cb579e-e445-4882-a49f-6aea52c8480a-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/a5cb579e-e445-4882-a49f-6aea52c8480a-/app/target,target=/app/target \
    cargo build --locked --release -p analytics-server --bin analytics-server --bin analytics-db --bin analytics-queue \
    && cp target/release/analytics-server target/release/analytics-db target/release/analytics-queue /usr/local/bin/

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app
WORKDIR /app
COPY --from=backend /usr/local/bin/analytics-server /usr/local/bin/analytics-db /usr/local/bin/analytics-queue /usr/local/bin/
COPY --from=frontend /app/web/dist ./web/dist
ENV RUST_LOG=analytics_server=info,analytics_services=info,analytics_core=warn
USER app
EXPOSE 3000
CMD ["/usr/local/bin/analytics-server"]
