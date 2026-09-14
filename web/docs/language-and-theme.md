# Public-site language and theme

The landing page, pricing, FAQs and public dialogs support English, German and Danish. Dashboard/account copy and the dashboard example image remain English.

The TanStack Router root loader fetches `GET /api/preferences` from Axum. The API uses trusted country metadata: DK → Danish, DE/AT → German, everything else → English. The Rust ingress authenticates the Cloudflare proxy before accepting its country header; the app never requests browser location or uses a third-party IP lookup.

The footer saves explicit language and theme choices in `ab-language` and `ab-theme` preference cookies (one year, SameSite=Lax, Secure on HTTPS). Explicit language, including English, overrides country selection. Invalid cookies fall back safely. These preference cookies are separate from analytics tracking. The client validates the API response and uses its saved choices if the preference request fails.

Theme offers System, Light and Dark. It applies to global tokens, dialogs, marketing media and dashboard chart colors. The static HTML applies cookie preferences before the stylesheet paints, then the client owns the document language and theme. System colors follow OS changes. No server rendering or hydration is required.

Verification includes the frontend preference tests and Rust HTTP integration suite, TypeScript, the frontend build, and browser checks of pricing navigation plus saved Danish/light preferences after a direct route reload. The prior Railway migration also verified actual Danish country detection and rejection of forged country headers. Local reports live under the ignored `web/artifacts/` directory. Current billing plans and entitlements are documented in [Polar billing](../../docs/polar.md).
