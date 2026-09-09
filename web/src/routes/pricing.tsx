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
          'Explore Datix Basic, Pro, and Ultra. Start Basic with a 14-day free trial, or contact sales above 5 million monthly events.',
      },
    ],
  }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <LandingLayout>
      <main id="main-content" className="pricing-page-content" tabIndex={-1}>
        <PricingSection />
      </main>
    </LandingLayout>
  );
}
