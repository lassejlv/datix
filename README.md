# Datix

Website analytics at [usedatix.com](https://usedatix.com). Cookieless by default. Existing tracker snippets on [analytics.beer](https://analytics.beer) keep working.

Create an account, add a site, paste the script, and wait for the first pageview. The dashboard covers pageviews, daily visitors, custom events, and breakdowns by page, referrer, country, and device.

## Stack

Rust/Axum API, React + TanStack Router frontend, Neon Postgres, Redis Streams. Production is Railway.

```
web/      frontend, tracker, tests
crates/   core, services, Axum server
config/   OpenAPI contract and Polar catalog
docs/     API, deployment, schema
```

JavaScript lives only in `web/`. The Rust binary serves `web/dist/client` in production.

## Development

Rust 1.96 and Bun 1.4.2. Copy `.env.example` to `.env`.

```sh
bun install --cwd web --frozen-lockfile
redis-server --bind 127.0.0.1 --port 6393 --appendonly yes --maxmemory-policy noeviction
bun run --cwd web dev
```

Open [localhost:3000](http://localhost:3000). Vite proxies `/api` and `/health` to Axum on port 3001.

```sh
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web lint
cargo test --locked --workspace
```

Database integration tests and browser QA are documented in [AGENTS.md](AGENTS.md).

## Tracker

```html
<script defer src="https://usedatix.com/tracker.js" data-site="YOUR-SITE-UUID"></script>
```

```js
window.simpleAnalytics.track('signup');
```

The tracker respects Do Not Track, sets no cookies in the default mode, and ignores query/fragment-only navigation. For a local site, turn on **Allow localhost for testing**. Full behaviour is in [docs/api.md](docs/api.md).

## Docs

- [API](docs/api.md)
- [Deployment](docs/deployment.md)
- [Billing](docs/polar.md)
- [Agent notes](AGENTS.md)
