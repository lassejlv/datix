(() => {
  const script = document.currentScript;
  const siteId = script?.getAttribute('data-site');
  const environmentId = script?.getAttribute('data-environment');
  const debug =
    script?.hasAttribute('data-debug') ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const log = (message) => {
    if (debug) console.info(`[Datix] ${message}`);
  };
  if (!siteId) {
    log('Missing data-site on the tracking script. No events will be sent.');
    return;
  }
  if (window.simpleAnalytics) {
    log('Tracker is already installed on this page.');
    return;
  }
  if (navigator.doNotTrack === '1') {
    log('Do Not Track is enabled in this browser. No analytics requests will be sent.');
    return;
  }
  const endpoint = new URL('/api/collect', script.src).href;
  const configUrl = new URL('/api/tracker-config', script.src);
  configUrl.searchParams.set('siteId', siteId);
  if (environmentId) configUrl.searchParams.set('environmentId', environmentId);
  let policy,
    policyAt = 0,
    policyRequest;
  async function getPolicy() {
    if (policy && Date.now() - policyAt < 60000) return policy;
    if (!policyRequest)
      policyRequest = fetch(configUrl.href, { credentials: 'omit' })
        .then(async (response) => {
          if (response.status !== 200) throw new Error('Tracking settings unavailable');
          const value = await response.json();
          if (typeof value.enabled !== 'boolean' || !value.settings)
            throw new Error('Invalid tracking settings');
          policy = value;
          policyAt = Date.now();
          return value;
        })
        .catch(() => {
          log('Tracking settings unavailable. Collection is paused.');
          return null;
        })
        .finally(() => {
          policyRequest = null;
        });
    return policyRequest;
  }
  if (['sessions', 'local'].includes(script.getAttribute('data-mode'))) {
    startSessions();
    return;
  }
  const throttleMs = 60_000;
  const storageKey = `analytics-beer:pageviews:${environmentId || siteId}`;
  const pageviews = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved))
      for (const entry of saved.slice(-256)) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          Number.isFinite(entry[1]) &&
          entry[1] <= Date.now() &&
          Date.now() - entry[1] < throttleMs
        )
          pageviews.set(entry[0], entry[1]);
      }
  } catch {
    /* Storage may be disabled; keep the in-memory throttle. */
  }
  function persist() {
    const now = Date.now();
    for (const [url, time] of pageviews)
      if (now - time >= throttleMs || time > now) pageviews.delete(url);
    while (pageviews.size > 256) pageviews.delete(pageviews.keys().next().value);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...pageviews]));
    } catch {
      /* Storage is optional. */
    }
  }
  startSessions(true);
  function startSessions(cookieless = false) {
    const scope = environmentId || siteId;
    const local = script.getAttribute('data-mode') === 'local';
    const identityKey = `analytics-beer:identity:${scope}`;
    const visitorCookie = `ab_visitor_${scope}`;
    const sessionCookie = `ab_session_${scope}`;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    let sequence = 0;
    let consent = false,
      generation = 0,
      lastInput = Date.now(),
      lastBeat = Date.now(),
      scrollMilestone = 0;
    let currentUrl = location.origin + location.pathname;
    const pending = new Set();
    const channel =
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(`analytics-beer:${scope}`)
        : null;
    const ignored = (element) =>
      !!element?.closest?.(
        '[data-analytics-ignore], [contenteditable]:not([contenteditable="false"]), input, textarea, select',
      );
    const pageIgnored = () =>
      document.documentElement.hasAttribute('data-analytics-ignore') ||
      document.body?.hasAttribute('data-analytics-ignore');
    function cookie(name) {
      try {
        return document.cookie
          .split(';')
          .map((value) => value.trim())
          .find((value) => value.startsWith(`${name}=`))
          ?.slice(name.length + 1);
      } catch {
        return undefined;
      }
    }
    function writeCookie(name, value, seconds) {
      try {
        document.cookie = `${name}=${value}; Path=/; Max-Age=${seconds}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
      } catch {
        /* No cookie access means no session collection. */
      }
    }
    function localIdentity() {
      try {
        const now = Date.now();
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(identityKey) || 'null');
        } catch {
          saved = null;
        }
        const visitorValid =
          uuid.test(saved?.visitorId || '') &&
          saved.visitorExpires > now &&
          saved.visitorExpires <= now + 90 * 86400000;
        const sessionValid =
          visitorValid &&
          uuid.test(saved?.sessionId || '') &&
          saved.sessionExpires > now &&
          saved.sessionExpires <= now + 1800000;
        const record = {
          visitorId: visitorValid ? saved.visitorId : crypto.randomUUID(),
          sessionId: sessionValid ? saved.sessionId : crypto.randomUUID(),
          visitorExpires: now + 90 * 86400000,
          sessionExpires: now + 1800000,
        };
        localStorage.setItem(identityKey, JSON.stringify(record));
        // No volatile fallback: blocked storage must not create misleading visitors.
        const stored = JSON.parse(localStorage.getItem(identityKey) || 'null');
        return stored?.visitorId === record.visitorId && stored?.sessionId === record.sessionId
          ? { visitorId: record.visitorId, sessionId: record.sessionId }
          : null;
      } catch {
        return null;
      }
    }
    function identity() {
      if (cookieless) return {};
      if (local) return localIdentity();
      let visitorId = cookie(visitorCookie),
        sessionId = cookie(sessionCookie);
      if (!uuid.test(visitorId || '')) visitorId = crypto.randomUUID();
      if (!uuid.test(sessionId || '')) sessionId = crypto.randomUUID();
      writeCookie(visitorCookie, visitorId, 90 * 86400);
      writeCookie(sessionCookie, sessionId, 1800);
      return cookie(visitorCookie) === visitorId && cookie(sessionCookie) === sessionId
        ? { visitorId, sessionId }
        : null;
    }
    const dimension = (value) => Math.max(0, Math.min(20000, Math.round(Number(value) || 0)));
    function safeUrl(value) {
      if (!value) return undefined;
      try {
        const url = new URL(value, location.href);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          ? url.origin + url.pathname
          : undefined;
      } catch {
        return undefined;
      }
    }
    function target(element) {
      const label = element.closest('[data-analytics-label]')?.getAttribute('data-analytics-label');
      if (label && /^[a-zA-Z0-9_.:()> -]{1,80}$/.test(label)) return label;
      const parts = [];
      for (let node = element; node && parts.length < 4; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        const position = node.parentElement
          ? [...node.parentElement.children]
              .filter((child) => child.tagName === node.tagName)
              .indexOf(node) + 1
          : 1;
        parts.unshift(`${tag}:nth-of-type(${position})`);
      }
      return parts.join(' > ').slice(0, 160);
    }
    async function sendActivity(kind, details = {}, name) {
      if (!consent || pageIgnored() || navigator.doNotTrack === '1') return;
      const page = location.origin + location.pathname;
      const requestGeneration = generation;
      const config = await getPolicy();
      if (
        !config?.enabled ||
        config.settings[kind] !== true ||
        !consent ||
        requestGeneration !== generation ||
        navigator.doNotTrack === '1'
      )
        return;
      const settings = config.settings;
      details = { ...details };
      if (!settings.coordinates) {
        delete details.x;
        delete details.y;
      }
      const ids = identity();
      if (!ids) {
        log('Tracking storage is unavailable. Visitor tracking is paused.');
        return;
      }
      const path = page;
      const now = Date.now();
      if (cookieless && kind === 'pageview') {
        const previous = pageviews.get(path);
        if (previous !== undefined && now >= previous && now - previous < throttleMs) {
          console.info('[Datix] Pageview ignored - throttled (same URL within 1 minute)');
          return;
        }
        pageviews.set(path, now);
        persist();
      }
      const payload = {
        siteId,
        ...(environmentId ? { environmentId } : {}),
        id: crypto.randomUUID(),
        type: kind === 'pageview' ? 'pageview' : 'event',
        ...(kind === 'pageview' ? {} : { name: name || `auto.${kind}` }),
        url: page,
        referrer: settings.referrer ? safeUrl(document.referrer) || '' : '',
        [cookieless ? 'activity' : 'session']: {
          ...(cookieless ? {} : { consent: true }),
          ...(local ? { storage: 'local' } : {}),
          ...ids,
          kind,
          details: {
            clientTime: Date.now(),
            sequence: sequence++,
            viewportWidth: settings.dimensions ? dimension(innerWidth) : 0,
            viewportHeight: settings.dimensions ? dimension(innerHeight) : 0,
            screenWidth: settings.dimensions ? dimension(screen.width) : 0,
            screenHeight: settings.dimensions ? dimension(screen.height) : 0,
            language:
              settings.language && /^[a-zA-Z0-9-]{0,35}$/.test(navigator.language || '')
                ? navigator.language || ''
                : '',
            ...details,
          },
        },
      };
      const epoch = generation;
      const controller = new AbortController();
      pending.add(controller);
      const attempt = async (retry = 0) => {
        if (!consent || epoch !== generation || pageIgnored() || navigator.doNotTrack === '1')
          return false;
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'text/plain' },
            credentials: 'omit',
            keepalive: true,
            signal: controller.signal,
          });
          log(`Collector returned HTTP ${response.status}.`);
          if (response.status >= 500 && retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, (retry + 1) * 2000));
            return attempt(retry + 1);
          }
          return response.status === 202 && (await response.json()).accepted === true;
        } catch {
          if (controller.signal.aborted) return;
          if (retry < 2) {
            await new Promise((resolve) => setTimeout(resolve, (retry + 1) * 2000));
            return attempt(retry + 1);
          }
        }
      };
      void attempt()
        .then((accepted) => {
          if (cookieless && kind === 'pageview' && !accepted && pageviews.get(path) === now) {
            pageviews.delete(path);
            persist();
          }
        })
        .finally(() => pending.delete(controller));
    }
    const diagnosticPage = crypto.randomUUID();
    const diagnosticIds = new Map();
    const seenErrors = new Set();
    let vitalsStarted = false;
    let errorsStarted = false;
    const diagnosticEndpoint = new URL('/api/telemetry', script.src).href;
    const cleanDiagnostic = (value, limit) =>
      String(value || '')
        .slice(0, limit)
        .replace(/https?:\/\/[^\s)"']+/g, (value) => {
          try {
            const url = new URL(value);
            url.search = '';
            url.hash = '';
            url.username = '';
            url.password = '';
            return url.href;
          } catch {
            return '';
          }
        })
        .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted]')
        .replace(/["'][^"'\n]*["']|\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
    async function diagnostic(kind, payload, metricId) {
      if (!consent || pageIgnored() || navigator.doNotTrack === '1') return;
      const epoch = generation;
      const url = location.origin + location.pathname;
      const config = await getPolicy();
      if (
        !config?.enabled ||
        config.features?.[kind === 'error' ? 'errors' : 'webVitals'] !== true ||
        !consent ||
        generation !== epoch ||
        pageIgnored() ||
        navigator.doNotTrack === '1'
      )
        return;
      let id = diagnosticIds.get(metricId);
      if (!id) {
        if (diagnosticIds.size >= 40) return;
        id = crypto.randomUUID();
        diagnosticIds.set(metricId, id);
      }
      const controller = new AbortController();
      pending.add(controller);
      try {
        await fetch(diagnosticEndpoint, {
          method: 'POST',
          credentials: 'omit',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain' },
          signal: controller.signal,
          body: JSON.stringify({
            siteId,
            environmentId: scope,
            id,
            pageId: diagnosticPage,
            url,
            kind,
            payload,
            consent: !cookieless && consent,
          }),
        });
      } catch {
        /* Diagnostics never disrupt the monitored page. */
      } finally {
        pending.delete(controller);
      }
    }
    function captureError(message, source, stack, line, column) {
      if (!consent || pageIgnored() || seenErrors.size >= 10 || policy?.features?.errors !== true)
        return;
      const payload = {
        message: cleanDiagnostic(message, 500),
        source: cleanDiagnostic(source, 512),
        stack: cleanDiagnostic(stack, 2000),
        line: Number(line) || 0,
        column: Number(column) || 0,
      };
      if (!payload.message) return;
      const key = JSON.stringify(payload);
      if (seenErrors.has(key)) return;
      seenErrors.add(key);
      void diagnostic('error', payload, key);
    }
    async function startDiagnostics() {
      if (!consent || pageIgnored() || navigator.doNotTrack === '1') return;
      const config = await getPolicy();
      if (!config?.enabled || !consent || pageIgnored()) return;
      if (config.features?.errors === true && !errorsStarted) {
        errorsStarted = true;
        addEventListener('error', (event) => {
          try {
            captureError(
              event.message,
              event.filename,
              event.error?.stack,
              event.lineno,
              event.colno,
            );
          } catch {
            /* Ignore hostile error getters. */
          }
        });
        addEventListener('unhandledrejection', (event) => {
          try {
            captureError(
              event.reason?.message ||
                (typeof event.reason === 'string' ? event.reason : 'Unhandled promise rejection'),
              '',
              event.reason?.stack,
              0,
              0,
            );
          } catch {
            /* Ignore hostile rejection getters. */
          }
        });
      }
      if (config.features?.webVitals === true && !vitalsStarted) {
        vitalsStarted = true;
        try {
          const module = await import(new URL('/web-vitals.js', script.src).href);
          if (!consent || pageIgnored() || navigator.doNotTrack === '1') {
            vitalsStarted = false;
            return;
          }
          module.observe((id, name, value) => {
            void diagnostic('vital', { name, value }, id);
          });
        } catch {
          vitalsStarted = false;
        }
      }
    }
    function setConsent(granted, broadcast = true) {
      if (granted !== true) {
        consent = false;
        generation++;
        for (const controller of pending) controller.abort();
        pending.clear();
        if (local) {
          try {
            localStorage.removeItem(identityKey);
          } catch {
            /* Storage may be blocked. */
          }
        } else if (!cookieless) {
          writeCookie(visitorCookie, '', 0);
          writeCookie(sessionCookie, '', 0);
        }
        if (broadcast) channel?.postMessage(false);
        return;
      }
      if (consent || navigator.doNotTrack === '1') return;
      consent = true;
      void startDiagnostics();
      lastInput = lastBeat = Date.now();
      scrollMilestone = 0;
      sendActivity('pageview');
    }
    if (local)
      addEventListener('storage', (event) => {
        if ((event.key === identityKey || event.key === null) && event.newValue === null)
          setConsent(false, false);
      });
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === false) setConsent(false, false);
      };
    window.simpleAnalytics = {
      consent: (granted) => setConsent(granted),
      track: (name) => {
        if (typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name))
          sendActivity('custom', {}, name);
      },
    };
    function navigation() {
      const url = location.origin + location.pathname;
      if (url === currentUrl) return;
      currentUrl = url;
      scrollMilestone = 0;
      lastInput = lastBeat = Date.now();
      sendActivity('pageview');
    }
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        navigation();
        return result;
      };
    }
    addEventListener('popstate', navigation);
    document.addEventListener(
      'click',
      (event) => {
        if (
          !consent ||
          pageIgnored() ||
          !(event.target instanceof Element) ||
          ignored(event.target)
        )
          return;
        lastInput = Date.now();
        const element = event.target.closest('a,button,[role="button"]') || event.target;
        if (ignored(element)) return;
        const details = {
          target: target(element),
          x: Math.max(
            0,
            Math.min(100, Math.round((event.clientX / Math.max(1, innerWidth)) * 100)),
          ),
          y: Math.max(
            0,
            Math.min(100, Math.round((event.clientY / Math.max(1, innerHeight)) * 100)),
          ),
        };
        sendActivity('click', details);
        const link = element.closest('a[href]');
        const destination = link ? safeUrl(link.href) : undefined;
        if (destination && link.hasAttribute('download'))
          sendActivity('download', { ...details, destination });
        else if (destination && new URL(destination).origin !== location.origin)
          sendActivity('outbound', { ...details, destination });
      },
      { capture: true, passive: true },
    );
    document.addEventListener(
      'submit',
      (event) => {
        if (
          consent &&
          !pageIgnored() &&
          event.target instanceof Element &&
          !ignored(event.target)
        ) {
          lastInput = Date.now();
          sendActivity('form_submit', { target: target(event.target) });
        }
      },
      { capture: true, passive: true },
    );
    let scrollQueued = false;
    addEventListener(
      'scroll',
      () => {
        if (!consent || pageIgnored()) return;
        lastInput = Date.now();
        if (scrollQueued) return;
        scrollQueued = true;
        setTimeout(() => {
          scrollQueued = false;
          const distance = document.documentElement.scrollHeight - innerHeight;
          const depth = distance > 0 ? Math.min(100, Math.floor((scrollY / distance) * 4) * 25) : 0;
          if (depth > scrollMilestone) {
            scrollMilestone = depth;
            sendActivity('scroll', { scrollDepth: depth });
          }
        }, 500);
      },
      { passive: true },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (consent && !ignored(event.target)) lastInput = Date.now();
      },
      { passive: true },
    );
    function engagement() {
      const now = Date.now();
      const seconds = Math.min(30, Math.floor((now - lastBeat) / 1000));
      if (
        consent &&
        !pageIgnored() &&
        document.visibilityState === 'visible' &&
        now - lastInput <= 30000 &&
        seconds > 0
      )
        sendActivity('engagement', { activeSeconds: seconds });
      lastBeat = now;
    }
    setInterval(engagement, 15000);
    setInterval(() => {
      void startDiagnostics();
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      lastBeat = Date.now();
    });
    addEventListener('pagehide', engagement);
    // Consent belongs to the website: load this script only once the visitor has agreed.
    // Tracking starts on its own, so a site that gates the snippet needs no further wiring.
    // analyticsBeerConsent = false suppresses the start, and consent(false) revokes later.
    if (!cookieless && window.analyticsBeerConsent === false)
      log('Visitor tracking is off because analyticsBeerConsent is false.');
    else if (document.visibilityState === 'prerender')
      document.addEventListener('visibilitychange', () => setConsent(true), { once: true });
    else setConsent(true);
  }
})();
