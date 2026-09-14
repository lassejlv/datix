# DPA operation and release

The public `/dpa` page and `/api/dpa/download` use `web/src/content/legal/dpa.html`.
The download contains the DPA and Terms in a standalone HTML file; browser printing saves a PDF.
`config/legal.json` identifies both document versions. Authenticated acceptance preserves the exact
UTF-8 HTML, SHA-256 checksums, verified email, representative, customer identity and database time.
Account settings list earlier acceptance records with private downloads. No IP or user agent is
added to contract evidence. The contract record survives account deletion with a null account link.

## Acceptance and data access

Email, Google and GitHub users enter the same agreement step after verified sign-in. Existing users
are not silently enrolled. Signup explains the Terms and the following DPA step. Creating an
account, opening a PDF, accepting visitor cookies or paying does not create a DPA acceptance.
Users can manage/delete accounts and reach billing cancellation without accepting.

The API rejects new site/configuration writes, imports, onboarding completion and checkout without
the current acceptance. Tracker configuration disables collection, collectors reject before storing
analytics or queuing diagnostics, and workers recheck acceptance. Usage reports `agreement_required`.
Reading existing records and deletion do not require new agreement acceptance; ordinary account,
subscription and ownership checks continue to apply. Acceptance never grants a subscription.

Submitted versions and checksums must match the server and browser document build. Repeated acceptance
is idempotent and cannot overwrite the original evidence. Always change the relevant version when
changing published document bytes, including formatting. Never rewrite a previously accepted version.
Notify affected customers before a material revision; plan the collection pause and new acceptance.
The service currently requires both current versions, so changing either one requires acceptance.
Separately signed contracts and corrections require owner handling; do not create a false self-service
acceptance record or backdate acceptance to bypass the gate.

## Database and deployment

Migration `0002_legal_acceptances.sql` only adds a table. The original two migrations and production
catalog snapshot remain unchanged. It must be applied with the existing reviewed migration CLI,
followed by `runtime-role --apply`, before starting the new API. There are no startup migrations.
Production migration and deployment require a separate explicit request under `AGENTS.md`.

The existing strict runtime schema check expects an exact complete migration ledger. An older binary
therefore cannot start on a newer ledger even for this additive change. Do not promise a rollback to
an old binary without addressing that compatibility check in a separately reviewed release plan.

Rehearsal on 14 September 2026: all three migrations applied successfully to the initially empty
`datix_dpa_rehearsal_20260914` database on the isolated `dev-rust-20260914` branch. The development
`datix` database then received the additive migration for integration checks. No production rows
were copied and no production migration was performed. The rehearsal database contains schema only
and shares the development branch's scheduled expiry.

Verification on 14 September 2026: `bun run check`, `bun run build` and all six isolated
database/Redis integration tests passed. Browser checks covered the public DPA, unchecked consent
validation, verified-account acceptance, subsequent onboarding, and an unpaid account's private
agreement download. Disposable browser and failed-test fixtures were removed. Provider calls stayed
disabled or used loopback mocks. The Docker build inputs were updated, but container execution was
not tested because no Docker/container engine is available in this workspace.

## Owner responsibilities before publishing

The DPA uses existing operator identity and the actual tracker, retention, auth and infrastructure
code. Its legal promises also require operational follow-through. The following cannot be established
from source code or a provider's public DPA alone:

- TODO(confirm): applicable contract/DPA acceptance for the actual Unkey Compute, Neon, Upstash,
  Cloudflare and Sentry accounts and services. Unkey's public privacy page is not itself evidence of
  an Article 28 agreement. Sentry's public DPA describes electronic acceptance/opt-in.
- TODO(confirm): specific processing/support locations and the actual Chapter V safeguards for each
  provider and its onward transfers, including assessments or supplementary measures where required.
- TODO(confirm): operator access review, confidentiality, breach contact/escalation, backup restoration
  and deletion procedures. Do not treat the organizational commitments in Annex B as certifications.
- TODO(confirm): recovery/log/backup deletion cycles and manual handling of diagnostic recovery data,
  residual archives and contract records. Account deletion is not proof of provider-wide deletion.
- TODO(confirm): identify and authorize any optional S3 archive provider before enabling it for customer
  personal data. Likewise, cover any additional support/email provider before sending visitor data.

For a new subprocessor, send advance email notice to customer contacts with the identity, purpose,
locations and opportunity to object. Resolve objections before processing through that provider.
This is an owner-operated contractual workflow; editing the page does not send notifications.
For a breach, notify affected customers without undue delay after awareness, provide known facts
and follow up as the investigation progresses. Record the response and assistance provided.
For return/deletion or audit requests, verify authority, agree a workable scope, include provider
copies and recovery queues, document completion and retain only justified evidence.

## Evidence used for drafting

| Finding                                                        | Evidence                                                                                                                                                                                                                                                                      | Effect                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Danish individual operator, professional customers             | Existing Terms and Privacy Policy                                                                                                                                                                                                                                             | Same parties, jurisdiction and contact                                                                                 |
| Customer controller or processor; Datix processor/subprocessor | Tracker settings, ownership checks, current privacy scope                                                                                                                                                                                                                     | Covers both customer roles                                                                                             |
| Daily HMAC and optional persistent identifiers                 | `crates/api/src/tracking.rs`, `web/public/tracker.js`                                                                                                                                                                                                                         | No blanket anonymous/cookieless exemption                                                                              |
| Analytics, diagnostics, receipt and archive retention differ   | `maintenance.rs`, `queue.rs`, original retention SQL, Privacy Policy                                                                                                                                                                                                          | Concrete retention and residual-copy handling                                                                          |
| Verified session and origin/ownership checks                   | `http.rs`, `datix-auth`                                                                                                                                                                                                                                                       | Server-derived signer email and private receipts                                                                       |
| Article 28 obligations and transfer distinction                | [EU Commission clauses](https://eur-lex.europa.eu/eli/dec_impl/2021/915/oj/eng), [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)                                                                                                                                    | Instructions, security, assistance, audits, subprocessing and return/deletion; no claim that this DPA is transfer SCCs |
| Provider contractual roles                                     | [Unkey privacy](https://www.unkey.com/policies/privacy), [Neon DPA](https://neon.com/pdf/DPA.pdf), [Upstash DPA](https://upstash.com/static/trust/dpa.pdf), [Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/), [Sentry DPA](https://sentry.io/legal/dpa/) | Published provider terms verified 14 September 2026; account-level applicability remains for owner confirmation        |

This is an original Datix agreement organized around Article 28 obligations, not a claim to reproduce
the Commission's unmodified standard clauses. Have the owner/legal reviewer assess its operational
commitments before publication.
