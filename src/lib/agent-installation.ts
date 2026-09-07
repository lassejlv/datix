import type { SiteEnvironment } from './client';

export function agentInstallationInstructions(code: string, environment: SiteEnvironment) {
  return `Install Analytics Beer in this website's existing codebase.

Target domain: ${environment.domain}
Environment: ${environment.name}
Tracking mode: ${environment.trackingMode}
${environment.trackingMode === 'local' ? 'Use local storage only, with no tracking cookies. Visitor IDs expire after 90 days of inactivity; sessions expire after 30 minutes. Keep the data-mode="local" attribute.' : ''}

1. Inspect the framework and find its shared document/head or supported script integration. Add the following script exactly once across pages, preserving its URL, identifiers, and mode. Do not install a second copy if it already exists. Use the framework's supported equivalent when raw HTML is inappropriate. The tracker handles client-side navigation; do not add duplicate pageview listeners.

${code}

2. ${
    environment.trackingMode !== 'cookieless'
      ? `Connect the existing consent banner's analytics choice. Do not grant consent automatically. If there is no banner, add accept/reject choices and a way to withdraw consent. Apply its saved choice on every page, including before the deferred tracker loads:

function onAnalyticsConsentChanged(granted) {
  window.analyticsBeerConsent = granted === true;
  window.simpleAnalytics?.consent(granted === true);
}

Call this on initial consent restoration and whenever the choice changes. Rejection or withdrawal must pass false. The callback does not render a banner. Verify no tracking identifiers or activity requests are created before consent, tracking works after acceptance, and withdrawal stops collection and removes tracking identifiers. Keep private sections excluded with data-analytics-ignore; never add personal data to analytics labels.`
      : `Keep this integration cookieless. Do not add data-mode="sessions", tracking cookies, or session consent code. Preserve existing privacy preferences and do not disable Do Not Track.`
  }

3. Keep changes scoped to installation. Do not change the Analytics Beer environment settings or replace other analytics without the user's instruction. Localhost collection is currently ${environment.allowLocalhost ? 'enabled' : 'disabled'}; ${environment.allowLocalhost ? 'use localhost for verification when appropriate' : 'use the configured domain, or ask the user to enable localhost testing in Install if needed'}. Collection is ${environment.enabled ? 'enabled' : 'paused; ask the user to resume it before testing'}.

4. Run the project's relevant checks. In a normal browser, verify the script loads once, inspect /api/collect requests and their response (including accepted), and test navigation. Respect privacy controls and bot filtering; do not bypass them to force a pass. After publishing within the user's authorization, visit the configured domain and use Check installation in Analytics Beer to confirm a persisted pageview. A loaded script or HTTP 200 alone does not prove a pageview was stored. Report changed files, checks, and anything still awaiting live verification.`;
}
