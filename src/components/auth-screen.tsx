import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from './ui/icons';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Brand } from './brand';
import { BeerBuddy } from './onboarding';
import { PageTransition } from './page-transition';
import { apiClient, errorText, write, type User } from '../lib/client';

export function AuthScreen({
  onSignedIn,
  initialSignup = false,
  onModeChange,
}: {
  onSignedIn: (user: User) => void;
  initialSignup?: boolean;
  onModeChange?: (signup: boolean) => void;
}) {
  const [signup, setSignup] = useState(initialSignup);
  useEffect(() => setSignup(initialSignup), [initialSignup]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  return (
    <main
      className={`mx-auto min-h-dvh w-full px-6 py-7 md:px-10 md:py-10 ${signup ? 'max-w-[960px]' : 'max-w-[440px]'}`}
    >
      <div className="flex flex-col gap-1">
        <a
          href="/"
          aria-label="Analytics Beer home"
          className="w-fit rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <Brand />
        </a>
        {!signup && <span className="text-[13px] text-muted-foreground">analytics.beer</span>}
      </div>
      <div
        className={signup ? 'mt-8 grid items-center gap-8 lg:mt-16 lg:grid-cols-2 lg:gap-16' : ''}
      >
        {signup && (
          <aside className="hidden lg:block">
            <h2 className="text-[34px] font-medium leading-[1.15] tracking-tight">
              Small script.
              <br />
              Lovely insights.
            </h2>
            <p className="mt-3 max-w-[280px] text-sm leading-relaxed text-secondary-ink">
              See your visitors, popular pages, and traffic sources.
            </p>
            <BeerBuddy className="mt-6 h-40 w-40" />
          </aside>
        )}
        <PageTransition
          view={signup ? 'sign-up' : 'sign-in'}
          className={signup ? 'mx-auto w-full max-w-[360px] py-2' : 'mt-12 md:mt-16'}
        >
          {signup && <BeerBuddy className="mb-4 h-16 w-16 lg:hidden" />}
          <h1 className="text-[24px] leading-[1.25] font-medium tracking-[-0.025em]">
            {signup ? 'Make yourself at home.' : 'Sign in'}
          </h1>
          <p className="mt-2 text-sm text-secondary-ink">
            {signup ? 'Create an account to get started.' : 'View your website analytics.'}
          </p>
          <form
            onSubmit={submit}
            className={signup ? 'mt-6 flex flex-col gap-4' : 'mt-8 flex flex-col gap-[22px]'}
          >
            {signup && (
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="auth-name">
                Your name
                <Input
                  id="auth-name"
                  name="name"
                  autoComplete="name"
                  placeholder="Sam Taylor"
                  required
                  maxLength={80}
                  size={signup ? 'default' : 'lg'}
                />
              </label>
            )}
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="auth-email">
              Email address
              <Input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
                size={signup ? 'default' : 'lg'}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="auth-password">
              Password
              <div data-testid="password-control" className="relative">
                <Input
                  className="[&_input]:pr-[46px]"
                  id="auth-password"
                  name="password"
                  type={visible ? 'text' : 'password'}
                  autoComplete={signup ? 'new-password' : 'current-password'}
                  placeholder={signup ? 'At least 12 characters' : 'Enter your password'}
                  required
                  minLength={signup ? 12 : undefined}
                  maxLength={128}
                  size={signup ? 'default' : 'lg'}
                />
                <button
                  className={`absolute top-0 right-0 grid ${signup ? 'h-full w-9' : 'size-11'} cursor-pointer place-items-center text-secondary-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring`}
                  type="button"
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            {error && (
              <p className="text-sm leading-normal text-danger" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              size={signup ? 'default' : 'xl'}
              data-testid="auth-submit"
              className="mt-0.5 w-full text-sm sm:text-sm"
              loading={busy}
            >
              {signup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
          {signup && (
            <p className="mt-4 text-xs leading-relaxed text-secondary-ink">
              No card needed. No trial or subscription starts at signup.
            </p>
          )}
          <p className="mt-7 text-[13px] text-secondary-ink">
            {signup ? 'Already have an account?' : 'New to Analytics Beer?'}{' '}
            <button
              className="ml-[3px] cursor-pointer text-foreground underline underline-offset-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              type="button"
              onClick={() => {
                setSignup(!signup);
                onModeChange?.(!signup);
                setError('');
              }}
            >
              {signup ? 'Sign in' : 'Create an account'}
            </button>
          </p>
        </PageTransition>
      </div>
    </main>
  );
}
