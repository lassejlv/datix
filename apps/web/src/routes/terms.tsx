import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '../components/legal-page';
import html from '../content/legal/terms.html?raw';

export const Route = createFileRoute('/terms')({
  head: () => ({
    meta: [{ title: 'Terms of service | Datix' }, { name: 'robots', content: 'noindex' }],
  }),
  component: () => <LegalPage html={html} />,
});
