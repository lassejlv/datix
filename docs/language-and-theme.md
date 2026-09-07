# Public-site language and theme

The landing page, pricing, FAQs and public dialogs support English, German and Danish. Dashboard/account copy and the dashboard example image remain English.

The root loader reads Cloudflare request country metadata: DK → Danish, DE/AT → German, everything else → English. It never requests browser location or uses a third-party IP lookup. The footer saves explicit language and theme choices in `ab-language` and `ab-theme` preference cookies (one year, SameSite=Lax, Secure on HTTPS). Explicit language, including English, overrides country selection. Invalid cookies fall back safely. These preference cookies are separate from analytics tracking.

Theme offers System, Light and Dark. It applies to global tokens, dialogs, marketing media and dashboard chart colors. Saved preferences are server-rendered to keep hydration consistent. System colors follow OS changes.

Verification: `bun test tests/unit/site-preferences.test.ts`, `bun run typecheck`, `bun run build`, and `bun scripts/preferences-qa.ts`. Browser evidence is in `artifacts/landing/preferences-qa.json` and corresponding screenshots; three languages, three themes, persisted reloads, USD annual pricing previews, 320–1440px layouts, matching media, and no browser errors passed. Saved Danish/dark HTML was verified before JavaScript. Actual geographic routing at the Cloudflare edge has not been tested; deployment was not requested.

Pricing was simplified to two draft offers: Free ($0, 10,000 events/month, 3 websites, no time limit) and Pro (100k/$9, 250k/$19, 500k/$29, 1m/$49, 2m/$79, 5m/$149 per month; annual totals are 10 monthly payments; 10 websites and proposed 7-day trial at every level). Both include core reports, custom events and environments. The former Starter/Growth/Scale presentation was replaced. `bun scripts/pricing-qa.ts` verifies both prices, unchanged free pricing on annual billing, dialogs and focus restoration, computed hover styles, and all three locales at 1440/390/320px in light/dark themes. Billing and entitlements remain unimplemented.
