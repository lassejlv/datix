import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FooterPreferences, useSitePreferences } from './site-preferences';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff } from './ui/icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { GithubIcon, GoogleIcon } from '@hugeicons/core-free-icons';
import { Brand } from './brand';
import { PageTransition } from './page-transition';
import { apiClient, errorText, write, type User } from '../lib/client';
import '../landing.css';

// Display names stay untranslated brand names. To add a provider, extend this
// map with its icon and configure its credentials on the server.
const oauthProviders = {
  github: { label: 'GitHub', icon: GithubIcon },
  google: { label: 'Google', icon: GoogleIcon },
} as const;
type OAuthProvider = keyof typeof oauthProviders;
const isOAuthProvider = (value: unknown): value is OAuthProvider =>
  typeof value === 'string' && value in oauthProviders;

export function AuthScreen({
  onSignedIn,
  initialSignup = false,
  onModeChange,
}: {
  onSignedIn: (user: User) => void;
  initialSignup?: boolean;
  onModeChange?: (signup: boolean) => void;
}) {
  const { message: messageText, t } = useSitePreferences();
  const signup = initialSignup;
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [oauth, setOauth] = useState<OAuthProvider[]>([]);
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [oauthFailed] = useState(
    () => new URLSearchParams(window.location.search).get('oauth') === 'failed',
  );
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/preferences', { credentials: 'same-origin', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((preferences: unknown) => {
        const ids =
          typeof preferences === 'object' && preferences !== null
            ? (preferences as { oauth?: unknown }).oauth
            : null;
        if (Array.isArray(ids)) setOauth(ids.filter(isOAuthProvider));
      })
      .catch(() => {
        /* Email sign-in stays available when provider discovery fails. */
      });
    return () => controller.abort();
  }, []);
  async function startOauth(provider: OAuthProvider) {
    if (busy || oauthBusy) return;
    setOauthBusy(provider);
    setError('');
    try {
      const result = await apiClient<{ url: string }>(
        '/auth/sign-in/social',
        write('POST', { provider }),
      );
      window.location.assign(result.url);
    } catch (error) {
      setError(errorText(error));
      setOauthBusy(null);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await apiClient(
        `/auth/${signup ? 'sign-up' : 'sign-in'}/email`,
        write('POST', {
          email: form.get('email'),
          password: form.get('password'),
          ...(signup ? { name: form.get('name') } : {}),
        }),
      );
      const result = await apiClient<{ user: User }>('/me');
      onSignedIn(result.user);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const switchMode = () => {
    onModeChange?.(!signup);
    setError('');
    setVisible(false);
  };
  return (
    <div className="landing-page auth-page">
      <a className="landing-skip" href="#main-content">
        {t('Skip to content')}
      </a>
      <header className="auth-header">
        <a className="auth-brand" href="/" aria-label={t('Datix home')}>
          <Brand />
        </a>
        <a className="auth-back" href="/">
          <ArrowLeft size={14} aria-hidden="true" />
          {t('Back to home')}
        </a>
      </header>
      <main id="main-content" className="auth-main" tabIndex={-1}>
        <PageTransition view={signup ? 'sign-up' : 'sign-in'} className="auth-panel">
          <div className="auth-intro">
            <h1>{signup ? t('Make yourself at home.') : t('Welcome back.')}</h1>
            <p>
              {signup
                ? t('Create an account. Get to know your traffic.')
                : t('Sign in to see how your website is doing.')}
            </p>
          </div>
          {oauth.length > 0 && (
            <>
              <div className="auth-oauth">
                {oauth.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="outline"
                    className="auth-oauth-button"
                    disabled={busy || oauthBusy !== null}
                    loading={oauthBusy === provider}
                    onClick={() => void startOauth(provider)}
                  >
                    <HugeiconsIcon
                      icon={oauthProviders[provider].icon}
                      size={18}
                      aria-hidden="true"
                    />
                    {t('Continue with {provider}', {
                      provider: oauthProviders[provider].label,
                    })}
                  </Button>
                ))}
              </div>
              <div className="auth-divider" role="separator">
                <span>{t('or')}</span>
              </div>
            </>
          )}
          <form className="auth-form" onSubmit={submit}>
            {signup && (
              <label htmlFor="auth-name">
                {t('Your name')}
                <Input
                  id="auth-name"
                  name="name"
                  autoComplete="name"
                  placeholder="Sam Taylor"
                  required
                  maxLength={80}
                />
              </label>
            )}
            <label htmlFor="auth-email">
              {t('Email address')}
              <Input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </label>
            <label htmlFor="auth-password">
              {t('Password')}
              <div data-testid="password-control" className="auth-password">
                <Input
                  id="auth-password"
                  name="password"
                  type={visible ? 'text' : 'password'}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  placeholder={signup ? t('At least 12 characters') : t('Enter your password')}
                  required
                  minLength={signup ? 12 : undefined}
                  maxLength={128}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  type="button"
                  aria-label={visible ? t('Hide password') : t('Show password')}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </Button>
              </div>
            </label>
            {error ? (
              <Alert className="auth-error">{messageText(error)}</Alert>
            ) : (
              oauthFailed && (
                <Alert className="auth-error">{t('OAuth sign-in failed. Please try again.')}</Alert>
              )
            )}
            <Button
              loading={busy}
              className="auth-submit"
              type="submit"
              data-testid="auth-submit"
              disabled={busy}
              aria-busy={busy}
            >
              {signup ? t('Create account') : t('Sign in')}
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </form>
          <p className="auth-switch">
            {signup ? t('Already have an account?') : t('New to Datix?')}{' '}
            <button type="button" onClick={switchMode}>
              {signup ? t('Sign in') : t('Create an account')}
            </button>
          </p>
        </PageTransition>
      </main>
      <footer className="auth-footer">
        <p>{t('Website analytics. A little more human.')}</p>
        <nav aria-label={t('Footer navigation')}>
          <a href="/privacy">{t('Privacy')}</a>
          <a href="/terms">{t('Terms')}</a>
          <FooterPreferences />
        </nav>
      </footer>
    </div>
  );
}
