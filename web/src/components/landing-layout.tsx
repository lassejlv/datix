import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FooterPreferences, useSitePreferences } from './site-preferences';
import { Brand } from './brand';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';
import '../landing.css';

export function LandingLayout({
  children,
  home = false,
  pricing = false,
}: {
  children: ReactNode;
  home?: boolean;
  pricing?: boolean;
}) {
  const { t } = useSitePreferences();
  const [dialog, setDialog] = useState<'privacy' | null>(null);

  return (
    <div className="landing-page">
      <a className="landing-skip" href="#main-content">
        {t('Skip to content')}
      </a>
      <header className="landing-header">
        <nav className="landing-nav" aria-label={t('Main navigation')}>
          <a
            className="landing-brand"
            href="/"
            aria-label={t('Datix home')}
            aria-current={home ? 'page' : undefined}
          >
            <Brand />
          </a>
          <div className="landing-nav-links">
            <a href="/#how-it-works">{t('How it works')}</a>
            <a href="/pricing" aria-current={pricing ? 'page' : undefined}>
              {t('Pricing')}
            </a>
            <a href="/#questions">{t('FAQ')}</a>
          </div>
          <div className="landing-nav-actions">
            <a className="landing-sign-in" href="/signin">
              {t('Sign in')}
            </a>
            <a className="landing-button landing-nav-cta" href="/signup">
              {t('Start 14-day trial')}
            </a>
          </div>
          <MobileNavigation pricing={pricing} />
        </nav>
      </header>

      {children}
      <footer className="landing-footer">
        <div className="landing-footer-row">
          <a className="landing-footer-brand" href="/" aria-label={t('Datix home')}>
            <Brand />
          </a>
          <nav className="landing-footer-nav" aria-label={t('Footer navigation')}>
            <ul>
              <li>
                <a href="/#how-it-works">{t('How it works')}</a>
              </li>
              <li>
                <a href="/pricing" aria-current={pricing ? 'page' : undefined}>
                  {t('Pricing')}
                </a>
              </li>
              <li>
                <a href="/#questions">{t('FAQ')}</a>
              </li>
              <li>
                <a href="/signin">{t('Sign in')}</a>
              </li>
              <li>
                <a href="/terms">{t('Terms of service')}</a>
              </li>
              <li>
                <a href="/privacy">{t('Privacy policy')}</a>
              </li>
              <li>
                <a href="/dpa">{t('Data processing agreement')}</a>
              </li>
              <li>
                <button
                  type="button"
                  className="landing-inline-link"
                  onClick={() => setDialog('privacy')}
                >
                  {t('Tracking & privacy')}
                </button>
              </li>
              <li>
                <a href="mailto:hello@usedatix.com">hello@usedatix.com</a>
              </li>
            </ul>
          </nav>
          <FooterPreferences />
        </div>
        <p className="landing-footer-copyright">© {new Date().getFullYear()} Datix</p>
      </footer>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogPopup
          closeProps={{ 'aria-label': t('Close') }}
          className="landing-dialog"
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>{t('How tracking works')}</DialogTitle>
            <DialogDescription>
              {t('What the product collects, and what you control.')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {' '}
            <div className="landing-privacy-copy">
              <h3>{t('Cookieless by default')}</h3>
              <p>
                {t(
                  'The default tracker records anonymous daily visitors, page journeys, browser, device, screen size, language, clicks, links, downloads, form submissions, scroll depth, and active time. Form values and page text are excluded. Query strings and URL fragments are discarded. Do Not Track is respected.',
                )}
              </p>
              <h3>{t('Persistent visitors are optional')}</h3>
              <p>
                {t(
                  'Persistent visitor tracking uses first party cookies or local storage and requires your visitor’s analytics consent before collection. You control this per environment. Detailed activity expires after 30 days.',
                )}
              </p>
              <h3>{t('Your account is separate')}</h3>
              <p>
                {t(
                  'Signing in uses an account session cookie. Account security records may contain IP and browser information. Avoid putting personal information in page paths or event names.',
                )}
              </p>
              <p>{t('This is a product explanation, not a legal privacy policy.')}</p>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function MobileNavigation({ pricing }: { pricing: boolean }) {
  const { t } = useSitePreferences();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current && event.target instanceof Node && !menu.current.contains(event.target)) {
        menu.current.open = false;
      }
    };

    const desktop = matchMedia('(min-width: 768px)');

    const closeOnDesktop = () => {
      if (desktop.matches && menu.current) menu.current.open = false;
    };

    document.addEventListener('pointerdown', closeOutside);
    desktop.addEventListener('change', closeOnDesktop);

    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      desktop.removeEventListener('change', closeOnDesktop);
    };
  }, []);

  return (
    <details
      ref={menu}
      className="landing-mobile-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary aria-label={t('Menu')}>
        <span className="landing-menu-icon" aria-hidden="true">
          <span />
          <span />
        </span>
      </summary>
      <div
        className="landing-mobile-links"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a') && menu.current) {
            menu.current.open = false;
          }
        }}
      >
        <a href="/#how-it-works">{t('How it works')}</a>
        <a href="/pricing" aria-current={pricing ? 'page' : undefined}>
          {t('Pricing')}
        </a>
        <a href="/#questions">{t('FAQ')}</a>
        <a className="landing-mobile-sign-in" href="/signin">
          {t('Sign in')}
        </a>
      </div>
    </details>
  );
}
