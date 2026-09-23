import { useSitePreferences } from './site-preferences';
import { ArrowRight, Check, Code2, Globe2, MousePointer2, Plus } from './ui/icons';
import { LandingLayout } from './landing-layout';
import { DashboardPreview } from './dashboard-preview';
import { freePlan } from '../lib/billing-plans';

const questions = [
  [
    'What can I see in my dashboard?',
    'Pageviews, daily visitor estimates, top pages, referrers, countries, devices, and custom events. Choose a date range to see how things change.',
  ],
  [
    'Does it use cookies?',
    'Tracking is cookieless by default. If you enable sessions and detailed activity, your website must collect analytics consent first. Account sign in uses a separate session cookie.',
  ],
  [
    'How do I install it?',
    'Create an account, add your website, and paste the tracking script into your site. The installation screen checks that your first pageview has arrived.',
  ],
  [
    'Can I track more than one website?',
    'Yes. Add multiple websites and switch between them in your dashboard. Each website has its own tracking script and reports.',
  ],
  [
    'Can I track events and test environments?',
    'Yes. Record custom events such as signups and downloads. On Pro, separate production, staging, and testing traffic with environments.',
  ],
  [
    'Is there a free plan?',
    'Yes. Free includes {count} credits per month for one website, with every report. Upgrade to Pro when you need more.',
  ],
] as const;

export function LandingPage() {
  const { number, t } = useSitePreferences();

  return (
    <LandingLayout home>
      <main id="main-content" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-intro">
            <h1 id="landing-title">
              {t('Understand your traffic.')}
              <br />
              <span>{t('Respect your visitors.')}</span>
            </h1>
            <p className="landing-description">
              {t('See your top pages, traffic sources, and custom events.')}
              <br className="landing-desktop-break" />{' '}
              {t('Cookieless website analytics. One script to get started.')}
            </p>
            <div className="landing-actions">
              <a className="landing-button" href="/signup">
                {t('Start for free')} <ArrowRight size={17} aria-hidden="true" />
              </a>
              <a
                className="landing-text-button"
                href="https://github.com/lassejlv/datix"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Code2 size={14} aria-hidden="true" /> {t('Open source on GitHub')}
              </a>
            </div>
          </div>
        </section>
        <DashboardPreview />

        <div className="landing-reassurance" aria-label={t('A simple place to start')}>
          {[t('Cookieless by default'), t('One script to install')].map((label) => (
            <span key={label}>
              <Check size={15} aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>

        <section id="how-it-works" className="landing-setup" aria-labelledby="setup-title">
          <h2 id="setup-title">{t('Turn your traffic into a next step.')}</h2>
          <ul className="landing-steps">
            <li>
              <span className="landing-step-icon" aria-hidden="true">
                <Globe2 size={20} />
              </span>
              <span className="landing-step-label">{t('Traffic sources')}</span>
              <h3>{t('Know where to focus.')}</h3>
              <p>
                {t('See which sites send you visitors. Put your effort where it gets noticed.')}
              </p>
            </li>
            <li>
              <span className="landing-step-icon" aria-hidden="true">
                <MousePointer2 size={20} />
              </span>
              <span className="landing-step-label">{t('Pages & events')}</span>
              <h3>{t('See what gets a response.')}</h3>
              <p>{t('Find popular pages and track actions like signups with custom events.')}</p>
            </li>
            <li>
              <span className="landing-step-icon" aria-hidden="true">
                <Code2 size={20} />
              </span>
              <span className="landing-step-label">{t('Separate environments')}</span>
              <h3>{t('Keep test traffic separate.')}</h3>
              <p>
                {t('Explore changes in a test environment. Keep your production reports clean.')}
              </p>
            </li>
          </ul>
          <p className="landing-setup-summary">
            {t('Get started: add your website, paste one script, and check your first visit.')}
          </p>
        </section>

        <section id="questions" className="landing-faq" aria-labelledby="questions-title">
          <h2 id="questions-title">{t('A few things worth knowing.')}</h2>
          <div className="landing-faq-list">
            {questions.map(([question, answer]) => (
              <details key={question} name="landing-questions">
                <summary>
                  {t(question)}
                  <Plus size={17} aria-hidden="true" />
                </summary>
                <p>{t(answer, { count: number(freePlan.events) })}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing-closing" aria-labelledby="closing-title">
          <h2 id="closing-title">{t('Here’s to a clearer picture.')}</h2>
          <a className="landing-button" href="/signup">
            {t('Start for free')} <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
      </main>
    </LandingLayout>
  );
}
