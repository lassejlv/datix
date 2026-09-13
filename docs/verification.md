# Verification — 2026-09-13

## Confirmed

- Bun 1.4.2, Vite+ 0.3.1 and Effect 4.0.0-rc.115 installed with a frozen lockfile.
- Workspace TypeScript checks and focused API/database/scripts lint pass.
- 10 backend tests pass, including legacy scrypt authentication, tracker identity/privacy, strict validation, imports, diagnostic sanitization, billing acknowledgments and webhook signatures.
- All 46 existing frontend unit tests pass. Frontend source matches the source checkout byte for byte except the relative billing-catalog import required by the `apps/web` move.
- Full local HTTP integration passes against the isolated Neon test branch and supplied Upstash Redis: signup/session, onboarding, two tenants, collection through BullMQ into Timescale, idempotent usage, reports, sessions, imports, telemetry, goals, legacy pending-receipt recovery, strict validation, origin rejection, administrator suspension/audit, suspended-user rejection, and clean Effect runtime shutdown.
- Browser password sign-in using a copied Rust-format credential succeeded. A signed legacy session was accepted. The migrated dashboard loads with the compiled Effect backend and displays the expected one pageview and one daily visitor.
- Copy rehearsals passed for the split source layout (35 tables) and the monolithic Rust layout (34 tables), including all-column and row-count reconciliation, repeated-copy recovery, and separate verification. Latest stable legacy reports are `.local/final-legacy-copy-report.json`, `.local/final-legacy-resume-report.json`, and `.local/final-legacy-verify-report.json`. Earlier split reports are `.local/copy-report.json`, `.local/copy-resume-report.json`, and `.local/copy-verify-report.json`.
- The production dependency layout was assembled independently from the workspace install; its compiled server serves frontend assets, passes readiness and shuts down cleanly.
- `bun run dev` starts Vite on 3000 and the API on 3001, and proxied readiness/liveness succeed.
- The new default database was independently verified as PostgreSQL 18.6, TimescaleDB 2.24.0, six hypertables and zero user rows. Runtime privileges and timeouts are checked at startup. A stale idle connection in the isolated rehearsal pool was recycled after applying role defaults; see the role-update note in the runbook.

## Deliberately not exercised

No deployment, push, DNS change, production data copy, real customer billing operation or OAuth provider consent flow was performed. No callable Unkey MCP tool was available, and no Docker/container engine is installed here, so the actual image build and Unkey startup remain unchecked.

The supplied primary source endpoint was inspected read-only and matches the split layout. The legacy analytics source needs a reachable endpoint or restored backup before a real copy can run. The older monolithic URL did not establish a usable database session. Synthetic copy fixtures do not prove production-volume performance; no load benchmark was run.

S3 is integrated through Bun for optional normalized import archives, but no bucket credentials were supplied for a live object-storage check. Live Google/GitHub sign-in and Polar checkout/webhook delivery remain cutover checks. Signature validation and local auth/billing behavior are covered by the checks above.

Secrets stay in ignored mode-600 environment files. SQL parameters and auth error objects are excluded from application logs.
