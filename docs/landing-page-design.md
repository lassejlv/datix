# Analytics Beer landing page

The page serves independent website owners. Its primary action is **Start tracking**, opening the existing account creation flow. The user's explicit centered, basic layout takes precedence over generic asymmetric or long landing page templates.

## Page outline

Centered navigation, hero and mascot video, factual reassurance, benefit statement, three setup actions, pricing, seven collapsed questions, closing action, compact footer. The dashboard preview lives in a dialog so the main page stays simple.

## Hero copy

**Good insights. Less head scratching.**

Understand your visitors, spot what works, and get back to building.

Primary action: Start tracking. Secondary action: Take a look.

Factual proof, beneath the hero: Cookieless by default. One script to install. No card needed.

## Benefits

- Find the pages people actually visit.
- See which referrers bring people to your website.
- Compare activity over time without building your own reports.
- Keep production and testing separate with environments.

## How it works

Add your website, paste your script, meet your visitors. These are a real ordered setup flow, which is why numbers are meaningful here.

## FAQ

- What can I see? Pageviews, daily visitor estimates, referrers, countries, devices and custom events.
- Does it use cookies? Default tracking does not; optional detailed sessions require consent. Account sessions are separate.
- How do I install it? Add the site's script and check for the first pageview.
- More than one website? Yes, each has its own script and reports.
- Events and environments? Both are supported.
- Trial? The proposed Starter plan has a 7 day free trial. Growth and Scale do not include a trial. Trial activation is not implemented.
- Credit card? No payment details are requested; previewing a plan does not start a subscription or trial.

## SEO and AEO

The evergreen homepage can be indexed. Preserve the existing title, add a specific description, social metadata and a favicon. FAQ content is ordinary HTML. No invented review schema or customer ratings.

## Layout and design tokens

Minimal conversion page, centered as explicitly requested. Existing IBM Plex Sans is retained across display, body and controls. This follows the Scandinavian skill's existing-brand rule over the generic new-site font defaults.

- Canvas: #ffffff; dark canvas: #181818.
- Ink: #202020; inverse ink: #ededed.
- Secondary text: alpha black 62%, alpha white 60%.
- Action: #242424 with #fafafa text; inverted in dark mode.
- Expressive amber stays inside the mascot artwork and a few subtle bubble accents.
- Controls: 8px radius. Floating navigation: full radius.
- DESIGN_VARIANCE 4, MOTION_INTENSITY 5, VISUAL_DENSITY 2.

The signature is a tiny beer mascot helping build a chart. Surrounding content uses neutral flat backgrounds. Existing icons and accessible dialog primitives are reused. No new runtime dependencies.

## Media

Built-in image generation produced the concept, isolated character and stage. Prompts asked for an amber glass beer mug with a foam head, small sneakers and a smile, helping build glass chart columns beside a laptop in a restrained miniature studio scene. Extraction prompts separated the character and scene onto alpha backgrounds.

Source PNGs: `output/landing-media/`. The repeatable render is `bun scripts/render-landing-video.ts`. Following the user's stop-motion request, a new six-pose sheet adds a crouch, block placement, open hands, a wave and a wink. Chroma-key compositing registers the poses on a fixed stage. The eight-second sequence is animated at 12fps and encoded on twos in 24fps H.264 at 960x600, with no frame interpolation. It sets down the block, waves and picks the block up again to close the loop. This is stop-motion-style animated artwork, not footage of a physical clay puppet or a working analytics chart.

Final files: `public/media/beer-stop-motion-light.mp4`, `beer-stop-motion-dark.mp4`, and themed WebP posters in full and small sizes. The previous smooth-hop assets are retained only with the source artwork for reference.

The website downloads one themed video. Still WebP posters appear immediately and remain for reduced motion or a video error. Playback pauses offscreen and in hidden tabs. The dashboard dialog uses screenshots of the actual app with synthetic QA traffic, explicitly labeled as example data.

## Pricing draft

The user requested a pricing section with a limited, 7 day free trial on the lowest plan and explicitly authorized draft example prices and limits. The centered section follows setup and is linked from desktop and mobile navigation. Starter uses an inverted card to highlight the trial; Growth and Scale have neutral outlined cards. Shared features are listed once beneath the comparison.

| Draft plan | Monthly, USD | Yearly, USD | Monthly events | Websites | Trial  |
| ---------- | ------------ | ----------- | -------------- | -------- | ------ |
| Starter    | $9           | $90         | 10,000         | 1        | 7 days |
| Growth     | $29          | $290        | 100,000        | 5        | None   |
| Scale      | $79          | $790        | 1 million      | 20       | None   |

The Monthly / Yearly switch changes both cards and selected-plan previews. The draft annual discount is two months off: one yearly payment equals ten monthly payments. Annual cards show the full yearly charge, with the rounded monthly equivalent underneath. Usage allowances remain monthly and the 7 day Starter trial applies to either billing period.

Events include pageviews and custom events. Prices and limits are clearly labeled examples. Plan buttons open a working preview with the exact selected terms, focus restoration, and a link to the existing account creation page. The preview explicitly says that creating an account does not start a subscription or trial. No checkout, billing entitlements, quotas or trial expiry enforcement were added in this design task.

Verified at 1440, 820, 390 and 320px in light and dark themes: layout without horizontal overflow, pricing navigation, all three plan previews, the Starter-only trial, Escape and keyboard focus restoration. Screenshots are `artifacts/landing/pricing-*.png`. Earlier Lighthouse scores below predate this addition.

## Scroll mascots

Two generated transparent poses extend the original character: a flying pose accompanies the benefits, and a winking, pointing pose sits beside the setup steps. Scroll progress moves the flying character through a small arc and gently tilts the pointing character. A stepped idle bob follows the stop-motion style. Both move into their own centered rows below 1200px so they do not obstruct copy or controls.

The shared pause button freezes the characters as well as the hero effects. Reduced motion renders static poses; offscreen and hidden-tab animation pauses. Images load lazily and decorative wrappers do not intercept clicks or enter the accessibility tree. Source files, final asset paths and exact built-in generation prompts are recorded in [scroll mascot prompts](../output/landing-media/scroll-mascot-prompts.md).

Browser inspection verified the two poses in light and dark themes at desktop and mobile widths down to 320px, actual scroll displacement, no overflow, shared pause, and reduced motion. Screenshots are `artifacts/landing/mascots-*.png`.

## Hero atmosphere experiment

At the user's request, the hero now has three depths of small drifting bubbles, concentrated at the edges to keep the centered headline clear. A few amber bubbles echo the mascot. The layers move at different speeds with scrolling and respond lightly to a fine pointer; the film stage scrolls slightly faster than the surrounding copy. Mobile uses half the visible particles and less film displacement.

The video pause button also freezes the added effects. Reduced motion keeps particles static and removes parallax, even when the visitor explicitly plays the mascot video. Decorative layers cannot intercept clicks or receive focus. Animation stops outside the viewport and in hidden tabs. Scroll updates use a single scheduled animation frame only while the hero is visible, with no new dependencies.

Verified this experiment at desktop and mobile sizes in light and dark themes, including actual scroll displacement, pause/resume, reduced motion and no horizontal overflow. Screenshots are `artifacts/landing/particles-*.png`. The Lighthouse numbers below were captured before the particle experiment.

## Scope boundaries

No deployment, billing changes or backend changes in the landing page work. Existing report URLs continue to open the app. The homepage is now public; `/signin` and `/signup` open existing authentication. Legacy auth query links redirect to these routes. Actual sign-in success opens the existing dashboard.

No legal terms or compliance claims are invented. The footer provides a factual tracking explanation, explicitly distinguished from a legal privacy policy. A real legal policy remains a separate launch requirement already noted in the deployment documentation.

## Verification

The final build, TypeScript check, and 22 unit tests pass. Landing browser checks pass in light and dark themes at 1440, 1024, 390 and 320px widths, covering centering, overflow, visible actions, keyboard focus, preview and privacy dialogs, FAQ, authentication links, playback controls, offscreen pause, reduced motion, and video failure fallback. The current route QA also passes through account creation, sign in, protected routes, site and environment navigation, legacy redirects and not-found handling.

Production-preview Lighthouse scores: performance 76, accessibility 100, best practices 96, SEO 100. Mobile throttling measured LCP at 4.5 seconds, with zero layout shift and zero blocking time; the 2.5-second LCP target is not met. The preview also records a 403 from the pre-existing external analytics collector. Reports and screenshots are in `artifacts/landing/`. An earlier full browser smoke run failed its sign-out navigation assertion while authentication routes were being changed in a concurrent task; the subsequent current route QA passed, but the entire original smoke suite was not rerun.
