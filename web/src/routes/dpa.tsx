import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '../components/legal-page';
import html from '../content/legal/dpa.html?raw';

export const Route = createFileRoute('/dpa')({
  head: () => ({ meta: [{ title: 'Data Processing Agreement | Datix' }] }),
  component: () => <LegalPage html={html} downloadable />,
});
