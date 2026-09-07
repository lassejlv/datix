# Dashboard organization

The dashboard uses Coss UI's sidebar, copied from its official registry and integrated with the existing Base UI controls. The redesign preserves IBM Plex Sans, the neutral light/dark palette, chart rendering, report data, page labels, and route structure.

The previous header separated website selection, navigation, account actions, and environment controls across three rows. The sidebar groups website and environment selection at the top, page navigation beneath them, creation actions in a secondary group, and the account at the bottom. A compact page header identifies the current website and page. Report date controls remain next to the report heading.

The design direction is a restrained product interface: design variance 3, motion intensity 2, visual density 5. Motion serves navigation state changes and respects reduced motion. Report pages keep imagery and decorative surfaces to a minimum; onboarding reuses the established beer mascot.

## Coss integration

Source: https://coss.com/ui/r/sidebar.json, plus its Sheet, Tooltip, Separator, Skeleton, and media-query dependencies. Existing Button, Input, ScrollArea, and utility components are reused. No new runtime packages were needed.

Adaptations:

- Use the existing semantic color and radius tokens.
- Match the media-query helper to Tailwind's 768px `md` breakpoint.
- Keep collapse state in the provider without introducing a sidebar preference cookie.
- Disable transitions under reduced motion and give the mobile sheet a plain scrim.
- Use real router links with active-page semantics, 44px mobile controls, and an expanded-state attribute on the sidebar toggle.

## Verification

`bun scripts/sidebar-qa.ts` exercises desktop collapse, the keyboard shortcut, hover and focus styling, tablet widths, mobile focus trapping and restoration, environment switching, page navigation, creation dialogs, and light/dark/reduced-motion behavior. `--production` uses the live site with an exact disposable account cleanup. Routing regressions are covered by `scripts/routes-qa.ts`.

Screenshots under `artifacts/sidebar/after-*` use synthetic data belonging to a disposable local design fixture. Local and production interaction evidence lives in `artifacts/sidebar/local/verification.json` and `artifacts/sidebar/production/verification.json`.

## Workspace switchers

The website and environment controls now share one compact context block. The website trigger shows the website name and domain; the environment appears as a lighter row underneath. Both use the official Coss Combobox component with search, selected-item checkmarks, keyboard navigation, and focus restoration. Website search matches names and domains. Selecting the current item leaves the route alone.

`bun scripts/switcher-qa.ts` covers search, empty results, keyboard selection, Escape, environment persistence, theme rendering, and a picker nested inside the mobile sidebar. `--production` checks the live version. Screenshots and results are in `artifacts/switchers/`.

The sidebar uses `variant="inset"` with Coss's `SidebarInset` wrapper. Desktop content sits inside a rounded surface with an 8px outer gutter; the surrounding workspace uses a subtle neutral tint scoped to the dashboard. Mobile retains the full-width content area and drawer. The wrapper supplies the single main landmark, with the existing skip-link target inside it.

## Visitor journeys

The Visitors route (`/site/:siteId/:environmentId/visitors`) replaces the inline sessions panel. It opens with a full-width, compact visit list. Selecting a visit opens a focused activity view with a back-to-list action at every size, restoring focus to the selected row. Deterministic animal aliases illustrate anonymous visitor keys; the short key is available in the visit detail and row tooltip. They do not imply a real identity.

The timeline shows each page once, alongside compact activity labels, timestamps, attribution and active time. It avoids a duplicate page trail, nested cards, oversized avatars, and an empty side panel. Summary metrics appear as a small inline group. Browser, language and screen details live in a disclosure. View visitor history applies an environment-scoped visitor filter to both the list and summary counts. Date filters, list pagination, activity pagination, retry states, setup guidance, and retained session data for cookieless environments are supported. Collection behavior and consent requirements are unchanged.

`bun scripts/journeys-qa.ts` creates synthetic activity only in a disposable fixture account, exercises both pagination paths and visitor filtering, and captures light/dark/mobile layouts. `scripts/sessions-qa.ts` verifies actual browser collection through the Queue to the Visitors timeline. Backend filtering and tenant isolation are covered in `tests/integration/sessions.test.ts`.

## Onboarding and simpler reports

The signup page and empty workspace use the existing beer mascot, neutral surfaces, and IBM Plex Sans. A clearly labeled interactive sample explains page and referrer reports without inserting any traffic into the user's account. First website creation opens `/site/:siteId/:environmentId/setup`; Getting started remains available from navigation. A browser-local, user-scoped preference resumes unfinished first-site setup from `/dashboard`. Direct report links remain direct.

Guided setup reuses Installation, including its current consent snippet and localhost controls. Optional local testing and custom-event instructions use a disclosure. A copied script never counts as success: the completion screen requires the existing installation endpoint to confirm a persisted pageview. The completion screen links to real reports and the existing plan preview; it neither starts a trial nor claims active billing. Error, pending, paused, and reload states remain actionable.

Overview metrics use a light underline to identify the selected chart metric. Repeated captions are removed from the visual hierarchy; the daily visitor estimate explanation remains below the reports. No tracking or billing behavior changes.

`bun scripts/onboarding-qa.ts` checks account creation, sample interaction, script copying, pending and resume states, actual tracker-to-Queue ingestion, completion focus, plan navigation, and desktop/mobile/dark rendering. It uses a disposable account and removes it afterward. Add `--production` with the production env file to run against the deployed app.

## Product-wide simplification and Hugeicons

All application icons now use the free rounded Hugeicons set through `src/components/ui/icons.tsx`, including shared Coss controls, password visibility, navigation, loading states, and activity rows. Lucide is removed. The adapter preserves SVG props and leaves explicitly labeled/status icons available to assistive technology. Anonymous visitor names remain stable; a small person icon replaces the varied animal drawings.

The landing page keeps one mascot film and removes the decorative particles, floating mascots, and repeated story section. Pricing uses quieter, compact columns with the same plan information and controls. Onboarding removes the duplicate three-feature explanation, uses smaller illustrations/headings, and reduces nested surfaces. Settings arrange related environment fields together; consent and destructive-action explanations remain visible. An empty overview no longer repeats four empty breakdowns beneath its main empty state.

Hugeicons source: `@hugeicons/react` and `@hugeicons/core-free-icons`, using the official React renderer and named icon exports. No Pro assets are used.

### Control alignment

Visitor date and refresh controls share a 32px desktop height (40px on mobile); Overview refresh matches its 32px date control. Workspace popups follow trigger width, use 32px desktop options, and truncate long names/domains with native title disclosure. Search uses one visible focus border. The account footer uses a smaller sign-out control and wraps email text. Live browser checks assert date/refresh heights and popup/trigger widths, alongside keyboard and mobile interactions.
