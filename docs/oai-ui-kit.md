# Datix UI kit

The interface uses the [OAI UI kit in Paper](https://app.paper.design/file/01M25GA8KKM41CKAZ2FHEP016Y/1-0), with implementation examples and icon paths from `/Users/lassevestergaard/Documents/ChatGPT/design-fun`. The existing analytics charts, globe geometry, navigation structure, and product behavior are retained.

## Shared components

`web/src/styles.css` owns the light/dark surface, text, border, focus, spacing, and motion tokens. Controls use 8 px corners; menus and calendars use 12 px corners. Most buttons and compact inputs are 32 px tall. Paper's tooltip colors are `#afafaf` and `#0d0d0d`, with 14/20 px typography, 8 px corners, and 250 ms easing. Reduced motion is respected.

The components under `web/src/components/ui/` cover buttons, inputs/textarea, selects, searchable comboboxes, checkboxes, switches, tabs, tooltips, dialogs, sheets, calendars, alerts, loading indicators, and toasts. Base UI manages popup placement, dismissal, focus trapping, and form semantics. Icons use the original example SVG paths where available, with companion paths for product-specific actions.

- Use `Select` with option children and `onValueChange`; keep translated labels and stable stored values together.
- Use `Switch` for persisted feature settings and `Checkbox` for acknowledgements and selections. Both retain native input semantics.
- Use `DatePicker` for ISO date values. It supports min/max bounds, arrow keys, Home/End, PageUp/PageDown, Enter, and Escape.
- Use `Hint` or `HintText` for contextual explanations. Icon buttons with an accessible label receive a tooltip automatically. The tooltip wrapper supplies the description relationship explicitly.
- Use `Alert` for form/report errors that need to remain visible. Use `toast.success` only after the server or clipboard operation succeeds; use `toast.error` for transient failures such as blocked clipboard access.
- `ToastProvider` lives under site preferences at the root. Notifications stack at the bottom right, remain dismissible over dialogs, and use localized labels. Success/info messages expire after five seconds and errors after eight seconds.
- `Tabs` provides the shared compact underline navigation, keyboard movement, and scrolling into view on narrow screens.

The kit is applied across authentication, onboarding forms, the dashboard, account/website/environment settings, installation, imports, usage/billing, feature reports, and public pages. The English, Danish, and German catalogs contain the new feedback and calendar labels.

## Validation

Start the frontend with `bun run --cwd web dev:frontend`, then run:

```sh
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web build
bun web/scripts/oai-kit-qa.ts
```

The Playwright acceptance script only permits localhost and intercepts API requests with isolated fixtures. It exercises ten workspace routes in both themes, keyboard selects/calendar/tooltips, workspace search, successful and failed saves, tracking consent, account dialogs, toast dismissal, clipboard errors, budgets, mobile layouts at 320/390 px, public/auth pages, and persisted language/theme preferences. It fails on uncaught browser errors or unexpected API paths. Screenshots and the acceptance report are written to gitignored `web/artifacts/oai-kit/`.

These checks validate the real frontend with synthetic responses. They do not establish authenticated backend integration, Polar checkout, webhook delivery, or production deployment acceptance.
