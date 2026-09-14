import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '../components/legal-page';
import html from '../content/legal/privacy.html?raw';

export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [{ title: 'Privacy policy | Datix' }],
  }),
  component: () => <LegalPage html={html} />,
});
