import { useSitePreferences } from './site-preferences';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Pause, Play, Plus } from './ui/icons';
import { LandingLayout } from './landing-layout';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';

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
    'Yes. Record custom events such as signups and downloads. Separate production, staging, and testing traffic with environments.',
  ],
  [
    'Is there a free trial?',
    'Pro 100k includes a 14-day free trial. Larger plans have no free trial. There is no permanent free plan. Monthly billing is available now; yearly billing is coming soon.',
  ],
  [
    'Do I need a credit card?',
    'No payment details are needed to create an account. Starting Pro requires completing checkout in Polar, where you confirm payment details and the price after your trial.',
  ],
] as const;

function MascotVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const { dark, darkMedia, t } = useSitePreferences();
  const [mounted, setMounted] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [userPaused, setUserPaused] = useState(false);
  const [userStarted, setUserStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => {
      setReduced(motion.matches);
      setUserStarted(false);
    };
    syncMotion();
    setMounted(true);
    motion.addEventListener('change', syncMotion);
    return () => {
      motion.removeEventListener('change', syncMotion);
    };
  }, []);

  const enabled = mounted && (!reduced || userStarted);
  const theme = dark ? 'dark' : 'light';
  useEffect(() => {
    const video = ref.current;
    if (!video || !enabled) return;
    let inView = true;
    const sync = () => {
      if (!inView || document.hidden || userPaused) video.pause();
      else void video.play().catch(() => setPlaying(false));
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        sync();
      },
      { threshold: 0.15 },
    );
    observer.observe(video);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      video.pause();
    };
  }, [enabled, theme, userPaused]);

  return (
    <figure className="landing-film">
      <div className="landing-film-stage">
        <picture>
          <source
            media={darkMedia}
            srcSet="/media/beer-stop-motion-poster-dark-small.webp 480w, /media/beer-stop-motion-poster-dark.webp 960w"
            sizes="(max-width: 767px) 100vw, 600px"
          />
          <img
            src="/media/beer-stop-motion-poster-light.webp"
            srcSet="/media/beer-stop-motion-poster-light-small.webp 480w, /media/beer-stop-motion-poster-light.webp 960w"
            sizes="(max-width: 767px) 100vw, 600px"
            width="960"
            height="600"
            fetchPriority="high"
            alt={t('A cheerful beer mug mascot builds an amber glass chart beside a tiny laptop.')}
          />
        </picture>
        <video
          ref={ref}
          src={enabled ? `/media/beer-stop-motion-${theme}.mp4` : undefined}
          muted
          loop
          playsInline
          preload="none"
          className={ready && !failed && enabled ? 'is-ready' : ''}
          aria-label={t(
            'A stop motion beer mascot places a chart block, waves, and gives a friendly wink.',
          )}
          onLoadedData={() => {
            setReady(true);
            setFailed(false);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            setFailed(true);
            setPlaying(false);
          }}
        />
      </div>
      <button
        className="landing-motion-button"
        type="button"
        aria-label={playing ? t('Pause animation') : t('Play animation')}
        disabled={failed || !mounted}
        onClick={() => {
          if (playing) {
            setUserPaused(true);
            ref.current?.pause();
          } else {
            setUserStarted(true);
            setUserPaused(false);
            if (enabled) void ref.current?.play().catch(() => setPlaying(false));
          }
        }}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {failed && (
        <figcaption role="status">
          {t('Animation unavailable. The illustration is still here.')}
        </figcaption>
      )}
    </figure>
  );
}

export function LandingPage() {
  const { t, darkMedia } = useSitePreferences();
  const [dialog, setDialog] = useState<'demo' | null>(null);
  return (
    <LandingLayout home>
      <main id="main-content" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-intro">
            <p className="landing-eyebrow">{t('Website analytics, simply.')}</p>
            <h1 id="landing-title">
              {t('Good insights.')}
              <br />
              <span>{t('Less head scratching.')}</span>
            </h1>
            <p className="landing-description">
              {t('Understand your visitors, spot what works,')}
              <br className="landing-desktop-break" /> {t('and get back to building.')}
            </p>
            <div className="landing-actions">
              <a className="landing-button" href="/signup">
                {t('Start tracking')} <ArrowRight size={17} aria-hidden="true" />
              </a>
              <button
                className="landing-text-button"
                type="button"
                onClick={() => setDialog('demo')}
              >
                <Play size={14} aria-hidden="true" /> {t('Take a look')}
              </button>
            </div>
          </div>
          <MascotVideo />
        </section>

        <div className="landing-reassurance" aria-label={t('A simple place to start')}>
          {[t('Cookieless by default'), t('One script to install'), t('No card needed')].map(
            (label) => (
              <span key={label}>
                <Check size={15} aria-hidden="true" />
                {label}
              </span>
            ),
          )}
        </div>

        <section id="how-it-works" className="landing-setup" aria-labelledby="setup-title">
          <h2 id="setup-title">{t('A small setup. Then you’re set.')}</h2>
          <ol className="landing-steps">
            <li>
              <span className="landing-step-number" aria-hidden="true">
                1
              </span>
              <h3>{t('Add your website')}</h3>
              <p>
                {t('A name and a domain.')}
                <br />
                {t('That’s your starting point.')}
              </p>
            </li>
            <li>
              <span className="landing-step-number" aria-hidden="true">
                2
              </span>
              <h3>{t('Paste your script')}</h3>
              <p>
                {t('Add it to your site.')}
                <br />
                {t('We’ll check it’s working.')}
              </p>
            </li>
            <li>
              <span className="landing-step-number" aria-hidden="true">
                3
              </span>
              <h3>{t('Meet your visitors')}</h3>
              <p>
                {t('See what brings them in.')}
                <br />
                {t('Find what keeps them interested.')}
              </p>
            </li>
          </ol>
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
                <p>{t(answer)}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="landing-closing" aria-labelledby="closing-title">
          <h2 id="closing-title">{t('Here’s to a clearer picture.')}</h2>
          <a className="landing-button" href="/signup">
            {t('Start tracking')} <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
      </main>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogPopup
          closeProps={{ 'aria-label': t('Close') }}
          className="landing-dialog sm:max-w-5xl"
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>{t('The useful stuff, at a glance.')}</DialogTitle>
            <DialogDescription>
              {t('An actual Analytics Beer dashboard, shown with example traffic.')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <picture>
              <source media={darkMedia} srcSet="/media/dashboard-dark.webp" />
              <img
                className="landing-demo"
                src="/media/dashboard-light.webp"
                alt={t(
                  'Analytics Beer dashboard with sample pageviews, daily visitors, a traffic chart, and page and referrer reports.',
                )}
                width="1440"
                height="1453"
                loading="lazy"
              />
            </picture>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </LandingLayout>
  );
}
