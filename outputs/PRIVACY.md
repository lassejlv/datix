# Analytiks Privacy Policy

Effective date: 8 September 2026

Draft for owner and legal review. Not yet published. The consent flow described for analytiks.app must be implemented before this policy is published; the current site starts its default analytics automatically.

## 1. Who is responsible

**Lasse Vestergaard**, operating Analytiks personally and based in **9000 Aalborg, Denmark**, is responsible for personal data used to operate [analytiks.app](https://analytiks.app) and [analytics.beer](https://analytics.beer), manage customer accounts, administer the service, and answer support and privacy requests. Our contact for privacy requests, support, and legal matters is [hello@analytiks.app](mailto:hello@analytiks.app).

This policy covers our website, application, API, tracking service, billing integration, and correspondence. Our role depends on the data:

- **Our accounts, own website, and business administration:** we determine the purposes and means of processing and act as controller.
- **Analytics collected for a customer's website:** the customer normally acts as controller and we process visitor data on its behalf. If the customer is itself a processor, we act as its subprocessor. The customer's privacy notice and any applicable data processing agreement also apply.

If your question concerns a website using Analytiks, contact that website's operator first. We can assist with requests concerning information we process on its behalf.

## 2. Account, billing, and support information

When you register, we collect your name, email address, and password. Passwords are stored as hashes. We also store an account identifier and account creation and update times. Authentication records include session identifiers, expiry times, the account's IP address, and browser user-agent information. This account security information is separate from website visitor analytics.

We store the website names, domains, environments, settings, and collection budgets you enter. Account use generates usage totals and operational information needed to provide, secure, and troubleshoot the service.

When you start a Polar checkout, we send Polar your name, email address, account identifier, selected plan, and checkout language. Polar collects the payment and billing information needed for the purchase, which can include your billing address, tax information, and payment details. Our application stores customer and checkout identifiers and selected subscription information, including plan, status, billing period, trial end, and cancellation state. It does not store your full payment-card number.

Our usage integration sends Polar your account identifier, event category, credit quantity, timestamp, and a delivery identifier. It does not include tracked visitors' identifiers, page paths, or IP addresses in those billing usage messages. Information entered directly into Polar's checkout is governed by [Polar's Privacy Policy](https://polar.sh/legal/privacy-policy).

If you email us, we receive your email address, message content, any information or attachments you choose to include, and related correspondence metadata. Please avoid sending passwords, full card details, or unnecessary personal information.

## 3. Information collected by the tracker

Collection depends on the website operator's settings and tracking mode. The tracker can collect:

- page paths, custom event names, timestamps, referrer hostnames, and country derived from the network request;
- browser family, operating system, device category, language, and viewport and screen dimensions;
- clicks, outbound links, downloads, form submission events, scroll depth, and active time;
- a structural description of the interacted element or an explicit analytics label, click position expressed relative to the viewport, and link destinations without query strings or fragments;
- pseudonymous identifiers used to group the recorded activity, as described below.

The standard tracker excludes typed field values, passwords, keystroke values, page text, and full page contents. It produces an activity timeline, not video or visual session replay. Query strings and URL fragments are removed from the page and destination URLs it sends, and the collector stores referrer hostnames.

Page paths, event names, link paths, or labels can nevertheless contain personal information. Customers must avoid including it and exclude inappropriate pages or elements. A pseudonymous identifier or a report containing a sensitive path should not be treated as necessarily anonymous.

IP addresses and browser headers are processed when requests reach our infrastructure. The collector uses them for visitor estimates, browser classification, security, and abuse prevention. Raw visitor IP addresses and full browser headers are not stored in our analytics event tables or normal analytics queue payloads. Our network providers process request information, and account authentication records can retain raw IP addresses and browser headers as explained above.

## 4. Tracking modes and visitor choices

### Default cookieless mode

The default mode does not create a persistent browser visitor or session identifier. It groups activity using a server-generated, keyed hash based on the environment, UTC date, IP address, and a bounded browser header. The grouping changes each UTC day and is scoped to the environment. Shared networks and browsers can be grouped together, and changing network information can split one person's activity.

This mode can still record the detailed activity listed above. It also uses `sessionStorage` to prevent repeated pageviews of the same page from being counted within one minute. That storage contains page addresses and timestamps, not visitor identifiers. Calling the mode cookieless does not mean that it is free of browser storage or automatically exempt from consent requirements.

### Optional cookie-based visitors

This mode requires affirmative analytics consent before visitor cookies or events are created. It uses first-party cookies scoped to the tracked environment:

| Cookie                     | Purpose                         | Expiry                            |
| -------------------------- | ------------------------------- | --------------------------------- |
| `ab_visitor_<environment>` | Recognize a returning browser   | 90 days, renewed with activity    |
| `ab_session_<environment>` | Group a browser's current visit | 30 minutes, renewed with activity |

The cookies hold randomly generated identifiers. The server converts them into keyed, environment-specific identifiers for stored analytics. This mode can link visits across days while the identifier remains valid and the relevant activity is retained.

### Optional local-storage visitors

This mode also requires affirmative analytics consent. It stores a record named `analytics-beer:identity:<environment>` in the tracked site's local storage instead of using visitor cookies. It contains random visitor and session identifiers and expiry timestamps. The visitor identifier is renewed for 90 days and the session identifier for 30 minutes with activity.

Expiry timestamps control whether identifiers are reused; local storage does not physically remove a record merely because its timestamp has expired. The record is removed when consent is withdrawn through the integration or when the browser's site data is cleared. If identity storage is blocked, this mode stops visitor collection rather than creating replacement in-memory identities.

### Consent and withdrawal

On **analytiks.app and analytics.beer**, we ask for consent before loading nonessential analytics or allowing its associated device access and browser storage. Rejecting optional analytics does not prevent access to the website or the account functions needed to provide the service. You can withdraw consent through the site's consent controls. Withdrawal stops future analytics; it does not retrospectively make earlier processing unlawful or automatically erase information already received.

On **customer websites**, the website operator supplies the consent controls and determines when tracking may start. The tracker does not itself remember the visitor's consent choice across page loads. The operator must restore that choice and obtain consent wherever legally required, including for default tracking where applicable. Persistent modes wait for the affirmative consent signal.

Withdrawal through the tracker integration stops future activity, cancels retries and pending requests where possible, and clears the relevant persistent visitor identifiers. Withdrawal is also communicated to other open tabs of the same site where browser support allows. Previously delivered records are handled through retention or a separate deletion request.

The tracker respects **Do Not Track**. It does not currently use **Global Privacy Control** as a signal to disable analytics. Browser site-data controls can remove stored information, but clearing data alone does not prevent a script from creating new data on a later visit. Use the site's consent controls or an appropriate browser blocking control as well.

## 5. Other browser storage on analytiks.app

We use storage for account and interface functions independently of optional visitor analytics:

| Storage                                     | Purpose                                                           | Duration                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `__Secure-better-auth.session_token` cookie | Maintain your signed-in session                                   | Browser session if not remembered; otherwise up to seven days, renewed with continued use |
| `__Secure-better-auth.dont_remember` cookie | Record a non-remembered sign-in choice                            | Browser session; the corresponding server session expires after one day                   |
| `ab-language` and `ab-theme` cookies        | Remember your selected language and appearance                    | One year from the setting being saved                                                     |
| Dashboard preferences in local storage      | Remember your selected website, environment, and unfinished setup | Until cleared or removed; these records have no fixed time expiry                         |
| Checkout selection in session storage       | Carry your selected plan through sign-in                          | Until consumed by the checkout flow or cleared with the tab session                       |

The default tracker's separate pageview-throttle entry uses the key `analytics-beer:pageviews:<environment>`. Entries stop affecting counts after one minute, but stored entries may remain until a later cleanup or the browser session ends. On our own site, this is part of the analytics controlled by consent.

You can change language and appearance using the website controls and remove cookies or other site data through your browser. Blocking sign-in storage can prevent account access. Cloudflare and Polar may also use storage on requests or pages they handle, according to their applicable services and privacy information.

## 6. Purposes and legal bases

Where the GDPR applies, we use the following bases for data for which we act as controller:

| Purpose                                                    | Information used                                                                            | Basis                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Create and operate your account and provide the service    | Account details, website settings, sessions, and usage                                      | Performance of our contract with you; legitimate interests in serving an organization where you act as its representative |
| Administer subscriptions and resolve payment issues        | Account identifiers, subscription state, usage, and correspondence                          | Contract; legitimate interests in administering business customer relationships; legal obligations where applicable       |
| Protect accounts, prevent abuse, and troubleshoot failures | Request information, session records, rate-limit and abuse signals, and operational records | Legitimate interests in protecting the service, customers, and visitors                                                   |
| Understand use of our own site through optional analytics  | Consented visitor and activity information                                                  | Consent                                                                                                                   |
| Remember requested interface choices                       | Language, appearance, and navigation preferences                                            | Legitimate interests in providing the interface and preferences you request                                               |
| Answer support requests and business correspondence        | Contact details, messages, and relevant account information                                 | Contract or legitimate interests in responding and resolving the matter                                                   |
| Comply with legal duties and handle legal claims           | Information relevant to the particular duty or claim                                        | Legal obligation or legitimate interests in establishing, exercising, or defending legal claims                           |

Our legitimate interests are limited to the purposes stated and must be balanced against your rights. You can object as explained below. Optional analytics consent is separate from accepting the service contract. You do not have to provide optional analytics information to buy or use the service, although information needed to create an account and process a payment is required for those functions.

For analytics collected on a customer's behalf, that customer determines the relevant legal basis and supplies the required visitor information. We process that information to provide its configured analytics service.

## 7. Who receives information

We use the following providers for the stated functions:

| Provider         | Function and relevant information                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Railway**      | Runs our application, background workers, and Redis queues. Processes service requests, account and event data passing through those systems, and operational information. See its [Privacy Policy](https://railway.com/legal/privacy) and [data processing terms](https://railway.com/legal/dpa).                                                                                                                                                                    |
| **Neon**         | Hosts the PostgreSQL database containing accounts, analytics, settings, and billing metadata. Neon is part of Databricks; see the current [Neon platform terms](https://neon.com/platform-terms).                                                                                                                                                                                                                                                                     |
| **Cloudflare**   | Provides the public site's proxy, network delivery, DNS, and security functions, including processing request information. Its Email Routing service also forwards messages sent to our contact address. See its [Privacy Policy](https://www.cloudflare.com/privacypolicy/) and [data processing terms](https://www.cloudflare.com/cloudflare-customer-dpa/).                                                                                                        |
| **Polar**        | Provides checkout, merchant-of-record services, subscription administration, and billing usage processing. It receives account and billing information described above. Polar has its own responsibilities for payment, tax, fraud prevention, and other processing described in its [Privacy Policy](https://polar.sh/legal/privacy-policy); its [data processing terms](https://polar.sh/legal/data-processing-addendum) apply to covered processing on our behalf. |
| **Google/Gmail** | Receives and stores support and privacy correspondence forwarded from our contact address. This includes message content, attachments, and metadata. See [Google's Privacy Policy](https://policies.google.com/privacy).                                                                                                                                                                                                                                              |

These providers do not all have the same legal role. Hosting and database providers process service data to support our operation. Polar also acts for its own transaction-related purposes. Google/Gmail handles correspondence under the privacy terms linked above.

We may disclose relevant information where a binding legal obligation requires it or where necessary and lawful to establish, exercise, or defend legal claims. Customer analytics reports are made available to the account authorized to access the relevant website and environment. They are not published as a public visitor directory.

## 8. Processing locations and international transfers

Our application, worker, and Redis services are currently deployed in a European Railway region. The primary Neon database is configured in Frankfurt, Germany. Those deployment locations do not mean that all processing stays in the EEA: network delivery, provider administration, support, payment processing, email, and provider subprocessors can involve other countries, including the United States.

We have agreed to Railway's [data processing agreement](https://railway.com/legal/dpa), which contains provisions for international transfers, including standard contractual clauses for relevant restricted transfers. Cloudflare's and Polar's applicable data processing terms also provide standard contractual clauses for relevant restricted transfers. Neon's current platform terms incorporate Databricks' contractual framework. Google's Privacy Policy describes international processing and its transfer arrangements.

Where we transfer personal data subject to the GDPR outside the EEA, an applicable adequacy decision or another valid safeguard, such as the European Commission's standard contractual clauses with any necessary supplementary measures, is required. Contact [hello@analytiks.app](mailto:hello@analytiks.app) for information about the safeguards applicable to your data and how to obtain a copy, subject to necessary redactions.

## 9. Retention and deletion

Different records serve different purposes and follow different retention rules:

| Information                                                    | Retention or deletion rule                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw analytics events and detailed activity                     | Scheduled deletion after approximately 30 days                                                                                                  |
| Daily visitor and session-grouping records                     | Approximately 30 days                                                                                                                           |
| Event receipt identifiers used to prevent duplicate processing | Approximately 31 days                                                                                                                           |
| Daily aggregate reports                                        | A rolling 730-calendar-day reporting window; report dimensions can still contain paths or event names                                           |
| Detailed abuse-source records                                  | Eligible for cleanup after two days without an update                                                                                           |
| Daily abuse summaries                                          | Approximately 90 days                                                                                                                           |
| Account and website settings                                   | Kept while the account or website exists, unless removed earlier through a relevant deletion request                                            |
| Authentication sessions                                        | Until sign-out, revocation, expiry, or account deletion, as applicable; expired records are removed by scheduled cleanup                        |
| Usage counters                                                 | Kept for account usage and billing administration; website deletion does not reset them; account deletion removes account-linked usage counters |

Scheduled cleanup uses bounded batches. The stated analytics periods are cleanup targets, not a promise that every copy disappears at the exact end of that period; scheduling, interruptions, or a processing backlog can delay removal.

Support and privacy correspondence is kept only while needed to resolve the matter, meet an applicable legal obligation, or establish, exercise, or defend a related legal claim. We assess that need according to whether the request remains open, whether follow-up is necessary, and whether a relevant legal duty or dispute requires continued retention. Correspondence is stored separately from the application database, so deleting an account does not automatically delete its email threads.

Successfully processed event messages are removed from the active processing queue. Failed or interrupted records can remain in recovery queues until reviewed, replayed, or removed. Failed queue records currently have no fixed automatic expiry. Database retention rules do not automatically erase these separate recovery records.

Account deletion removes the account and its linked websites, environments, analytics records, and authentication sessions from the active application database. A billing customer identifier and subscription snapshot can remain after the link to the deleted account is removed. Billing webhook delivery identifiers also remain separately; these records do not currently have an automatic scheduled expiry. Removing an account link is not a guarantee that the remaining billing information is anonymous.

Polar retains transaction information under its own legal and operational obligations. Deleting an Analytiks account does not erase Polar's records or complete a separate privacy request to Polar. Recovery copies, provider logs, and backups can also remain beyond deletion from the active application database, according to the relevant provider's recovery and retention processes. We do not promise that all provider logs or backups share the analytics retention period.

Use **Usage → Manage billing** to cancel renewal before deleting your account in account settings. Canceling a subscription alone stops future renewal; it does not delete historical reports or your account. Contact us if you need assistance with deletion, including residual records that require manual handling.

## 10. Your rights and requests

Depending on the applicable law and circumstances, you may request access to your personal data, correction, deletion, restriction of processing, or a portable copy. You may object to processing based on legitimate interests and withdraw consent at any time without affecting the lawfulness of processing before withdrawal.

We handle support and privacy requests through [hello@analytiks.app](mailto:hello@analytiks.app), including requests that require manual review or action. We may ask for information reasonably needed to verify your identity and locate the relevant records. We handle requests within the time required by applicable law; under the GDPR this is normally one month, with a permitted extension for complex or numerous requests and notice of the extension.

The dashboard supports account and website management and deletion, but there is no dedicated self-service personal-data export button. Contact us for access or portability assistance. Request information you need before deleting the account.

For a visit to a customer's website, contact its operator first and identify the website and approximate time of the visit. Pseudonymous records may not be identifiable from a name or email address alone. We do not need to collect additional identifying information solely to identify a person where the law does not require it, but we will consider information you provide that enables a request to be handled.

You can complain to the [Danish Data Protection Agency, Datatilsynet](https://www.datatilsynet.dk/), or another competent supervisory authority, including the authority in the EEA country where you live or work. Contacting us first is not a condition of that right.

## 11. Security and automated controls

Technical protections include password hashing, signed sign-in cookies, account-based access checks, and controls intended to limit unauthorized origins, duplicate events, and abusive traffic. These measures reduce risk; no service can guarantee absolute security. Report a suspected security or privacy issue to [hello@analytiks.app](mailto:hello@analytiks.app).

Automated rules can reject events or pause collection when traffic appears abusive or a subscription, allowance, or website budget prevents further collection. Contact us to request review if you believe a restriction is incorrect. These controls manage the service; they are not used to make credit, employment, or similar decisions about tracked visitors.

## 12. Children

Analytiks accounts are intended for business or professional users aged 18 or older. Contact us if you believe an account has been created by someone below that age.

The tracker does not determine a website visitor's age. The account age restriction therefore does not mean that children's visits can never be recorded on customer websites. Customers are responsible for the requirements applicable to their audience and for avoiding unlawful collection or profiling of children.

## 13. Changes and contact

We will update this policy when our practices change and show the new effective date. For material changes, we will provide additional information through the service or another appropriate channel. Where a new purpose requires fresh consent, we will ask for it.

**Controller for our own processing:** Lasse Vestergaard  
**City and country:** 9000 Aalborg, Denmark  
**Privacy, support, and legal requests:** [hello@analytiks.app](mailto:hello@analytiks.app)  
**Website:** [analytiks.app](https://analytiks.app) (also [analytics.beer](https://analytics.beer))
