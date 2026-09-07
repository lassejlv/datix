import { createFileRoute } from '@tanstack/react-router';
import { LandingLayout } from '../components/landing-layout';
import { PricingSection } from '../components/pricing-section';

export const Route = createFileRoute('/pricing')({
  head: () => ({
    meta: [
      { title: 'Pricing | Analytics Beer' },
      {
        name: 'description',
        content:
          'Explore Analytics Beer Pro with a 14-day free trial. Above 5 million monthly events, contact sales for Enterprise.',
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
