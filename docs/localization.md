# Website languages

Analytics Beer supports English (`en`), Danish (`da`) and German (`de`) across the public site, authentication, onboarding, dashboard, account settings, installation, imports, visitor activity and usage/billing screens.

Each language owns its copy in a separate TypeScript file:

- `web/src/lib/i18n/en.ts` is the English catalog and defines `Copy`.
- `web/src/lib/i18n/da.ts` contains Danish translations.
- `web/src/lib/i18n/de.ts` contains German translations.
- `web/src/lib/i18n/translations.ts` selects a catalog and interpolates named values.

The Danish and German catalogs must satisfy `Record<Copy, string>`. Adding a key to English without translating it produces a type error. The unit tests also verify identical keys and placeholders in every language.

Use `useSitePreferences().t` for interface copy and complete sentences with named values, such as `t('Delete {name}?', { name })`. Use `Translated` with named React slots when a sentence contains emphasized text or inline code. Do not concatenate translated sentence fragments or insert HTML from a translation.

The same hook provides `number`, `dateLabel`, and `dateTime`. Formatting follows the selected language while report dates remain in UTC and imported source dates retain their reporting timezone. Countries and generated visitor aliases are localized without changing identifiers. Stored website/environment names, paths, event names, browser information, code snippets, and required provider CSV column names remain their original values.

Existing API errors and import warnings arrive in English. `message` localizes known messages and complete templates while preserving filenames, dates and column names. Unknown diagnostics remain readable instead of disappearing. Store these messages in their original form so changing language also updates an already visible error or success message.

The language selector is available in the public footer, sign-in/sign-up pages, and Account settings. The `ab-language` cookie preserves the explicit choice for one year; it takes precedence over country detection. Country only picks the initial default (Danish for DK, German for DE/AT); English remains the fallback. Theme preferences are independent.

## Verification

```sh
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web build
bun --env-file=.env web/scripts/localization-qa.ts
```

Browser QA requires the explicitly matched isolated `TEST_DATABASE_URL` / `TEST_DATABASE_HOST`, a different production `DATABASE_URL` host, and the local API/frontend at `http://localhost:3060` (or `LOCALIZATION_QA_URL`, localhost only). It creates and removes its own fixture account. It checks language switching, persistence, focus, localized API errors, dates/numbers/countries, settings, consent text, imports/removal, mobile navigation and missing pages. Screenshots and results go to ignored `web/artifacts/localization/`.
