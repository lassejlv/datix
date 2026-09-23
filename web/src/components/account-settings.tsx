import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { FooterPreferences, useSitePreferences } from './site-preferences';
import { useState, type FormEvent } from 'react';
import { apiClient, errorText, write, type User } from '../lib/client';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DataProcessingAgreement } from './agreement';

export function AccountPage({
  user,
  onUpdated,
  onDeleted,
}: {
  user: User;
  onUpdated: (user: User) => void;
  onDeleted: () => void;
}) {
  const { t } = useSitePreferences();

  return (
    <div className="max-w-[600px]">
      <h1 className="text-2xl font-medium">{t('Account settings')}</h1>
      <p className="mt-2 text-sm text-secondary-ink">{t('Manage your profile and password.')}</p>
      <div className="mt-6">
        <AccountForm user={user} onUpdated={onUpdated} onDeleted={onDeleted} />
        <DataProcessingAgreement user={user} />
      </div>
    </div>
  );
}

function AccountForm({
  user,
  onUpdated,
  onDeleted,
}: {
  user: User;
  onUpdated: (user: User) => void;
  onDeleted: () => void;
}) {
  const { message: messageText, t } = useSitePreferences();
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState<'profile' | 'password' | 'delete' | null>(null);
  const [profileError, setProfileError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy('profile');
    setProfileError('');

    try {
      await apiClient('/auth/update-user', write('POST', { name: name.trim() }));
      onUpdated({ ...user, name: name.trim() });
      toast.success(t('Name saved.'));
    } catch (error) {
      setProfileError(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setPasswordError('');

    if (newPassword !== confirmation) {
      setPasswordError('The new passwords do not match.');

      return;
    }

    setBusy('password');

    try {
      await apiClient(
        '/auth/change-password',
        write('POST', { currentPassword, newPassword, revokeOtherSessions: true }),
      );
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      toast.success(t('Password changed. Other sessions are signed out.'));
    } catch (error) {
      setPasswordError(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('delete');
    setDeleteError('');

    try {
      const result = await apiClient<{ success: boolean }>(
        '/auth/delete-user',
        write('POST', { password: deletePassword }),
      );

      if (!result.success) throw new Error('Account deletion could not be completed.');
      toast.success(t('Account deleted.'));
      onDeleted();
    } catch (error) {
      setDeleteError(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  const fieldClass = 'flex flex-col gap-1.5 text-sm';

  return (
    <div>
      <section
        className="mb-5 border-b border-border pb-5"
        aria-label={t('Language and appearance')}
      >
        <FooterPreferences />
      </section>
      <form onSubmit={saveProfile} className="flex flex-col gap-4">
        <label className={fieldClass}>
          {t('Name')}
          <Input
            autoComplete="name"
            value={name}
            maxLength={80}
            required
            disabled={!!busy}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className={fieldClass}>
          {t('Email')}
          <Input
            type="email"
            autoComplete="email"
            value={user.email}
            readOnly
            className="text-secondary-ink"
          />
        </label>
        <Button
          type="submit"
          className="self-start"
          disabled={!!busy || !name.trim() || name.trim() === user.name}
          loading={busy === 'profile'}
        >
          {t('Save name')}
        </Button>
        {profileError && <Alert className="text-sm text-danger">{messageText(profileError)}</Alert>}
      </form>
      <details className="mt-5 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {t('Change password')}
        </summary>
        <form onSubmit={savePassword} className="mt-4 flex flex-col gap-4">
          <label className={fieldClass}>
            {t('Current password')}
            <Input
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={currentPassword}
              disabled={!!busy}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            {t('New password')}
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={newPassword}
              disabled={!!busy}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            {t('Confirm new password')}
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={confirmation}
              disabled={!!busy}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <p className="text-xs text-secondary-ink">
            {t('Use 12–128 characters. Your other sessions will be signed out.')}
          </p>
          <Button
            type="submit"
            className="self-start"
            loading={busy === 'password'}
            disabled={!!busy}
          >
            {t('Update password')}
          </Button>
          {passwordError && (
            <Alert className="text-sm text-danger">{messageText(passwordError)}</Alert>
          )}
        </form>
      </details>
      <details className="mt-5 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium text-danger focus-visible:outline-2 focus-visible:outline-ring">
          {t('Delete account')}
        </summary>
        <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
          {t(
            'Permanently removes your account, websites, environments, and collected analytics. This cannot be undone.',
          )}
        </p>
        <form onSubmit={deleteAccount} className="mt-4 flex flex-col gap-4">
          <label className={fieldClass}>
            {t('Confirm your password')}
            <Input
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={deletePassword}
              disabled={!!busy}
              onChange={(event) => setDeletePassword(event.target.value)}
            />
            <span className="text-[13px] leading-normal font-normal text-muted-foreground">
              {t('Leave blank if your account has no password.')}
            </span>
          </label>
          <Button
            type="submit"
            variant="destructive"
            className="self-start"
            loading={busy === 'delete'}
            disabled={!!busy}
          >
            {t('Permanently delete account')}
          </Button>
          {deleteError && <Alert className="text-sm text-danger">{messageText(deleteError)}</Alert>}
        </form>
      </details>
    </div>
  );
}
