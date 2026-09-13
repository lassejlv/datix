import { createFileRoute } from '@tanstack/react-router';
import { LandingLayout } from '../components/landing-layout';
import { PricingSection } from '../components/pricing-section';

export const Route = createFileRoute('/pricing')({
  head: () => ({
    meta: [
      { title: 'Pricing | Datix' },
      {
        name: 'description',
        content:
          'Compare Datix Basic, Pro, and Ultra. Every plan includes all reports and 10 websites. Start Basic with a 14-day free trial.',
      },
    ],
  }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <LandingLayout pricing>
      <main id="main-content" className="pricing-page-content" tabIndex={-1}>
        <PricingSection />
      </main>
    </LandingLayout>
  );
}
