import { useState, type ReactNode } from 'react';
import { useSitePreferences } from './site-preferences';
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

export function LandingLayout({ children, home = false }: { children: ReactNode; home?: boolean }) {
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
            <a href="/pricing" aria-current={!home ? 'page' : undefined}>
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
        </nav>
      </header>

      {children}
      <footer className="landing-footer">
        <div className="landing-footer-main">
          <div className="landing-footer-identity">
            <a href="/" aria-label={t('Datix home')}>
              <Brand />
            </a>
            <p>{t('Website analytics. A little more human.')}</p>
          </div>
          <nav className="landing-footer-nav" aria-label={t('Footer navigation')}>
            <ul>
              <li>
                <a href="/#how-it-works">{t('How it works')}</a>
              </li>
              <li>
                <a href="/pricing" aria-current={!home ? 'page' : undefined}>
                  {t('Pricing')}
                </a>
              </li>
              <li>
                <a href="/#questions">{t('FAQ')}</a>
              </li>
              <li>
                <a href="/signin">{t('Sign in')}</a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="footer-controls">
          <div className="footer-contact">
            <a className="landing-footer-email" href="mailto:hello@usedatix.com">
              hello@usedatix.com
            </a>
            <button
              type="button"
              className="landing-inline-link"
              onClick={() => setDialog('privacy')}
            >
              {t('Tracking & privacy')}
            </button>
          </div>
        </div>
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
