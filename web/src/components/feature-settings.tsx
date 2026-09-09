import { useState } from 'react';
import { apiClient, errorText, write, type SiteEnvironment } from '../lib/client';
import { featureDefinitions, featureSettings, type FeatureKey } from '../lib/features';
import { useSitePreferences } from './site-preferences';
import { PulseSettings } from './pulse';

export function FeatureSettings({ siteId, environment, onUpdated }: {
  siteId: string; environment: SiteEnvironment; onUpdated: (environment: SiteEnvironment) => void;
}) {
  const { t, message } = useSitePreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const settings = featureSettings(environment.featureSettings);
  async function toggle(key: FeatureKey) {
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(`/sites/${siteId}/environments/${environment.id}`,
        write('PATCH', { featureSettings: { ...settings, [key]: !settings[key] } }));
      onUpdated(result.environment); setSaved(true);
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section>
    <h2 className="text-[17px] font-medium">{t('Features')}</h2>
    <p className="mt-1 text-sm text-secondary-ink">{t('Choose the features for this environment. Web Vitals is on by default.')}</p>
    <div className="mt-5 divide-y divide-border">
      {featureDefinitions.map((feature) => <label key={feature.key} className="flex cursor-pointer items-center justify-between gap-6 py-5">
        <span><span className="block text-sm font-medium">{t(feature.label)}</span><span className="mt-1 block text-sm text-secondary-ink">{t(feature.description)}</span></span>
        <input type="checkbox" role="switch" aria-label={t(feature.label)} checked={settings[feature.key]} disabled={busy}
          onChange={() => void toggle(feature.key)} className="size-4 shrink-0 accent-primary" />
      </label>)}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-danger">{message(error)}</p>}
    {saved && <p role="status" className="mt-3 text-sm text-secondary-ink">{t('Changes saved.')}</p>}
    {settings.pulse && <div className="mt-8 border-t border-border pt-6"><PulseSettings siteId={siteId} environment={environment} /></div>}
  </section>;
}
