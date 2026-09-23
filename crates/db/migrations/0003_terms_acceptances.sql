-- Forward-only expansion. The DPA forms part of the Terms, so accepting the Terms no longer
-- requires the separately signed record in legal_acceptances. Each row snapshots both documents.
-- Signed legal_acceptances rows continue to count as Terms acceptance for their Terms version.
CREATE TABLE public.terms_acceptances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text REFERENCES public."user"(id) ON DELETE SET NULL,
    account_email text NOT NULL,
    terms_version text NOT NULL,
    dpa_version text NOT NULL,
    terms_sha256 text NOT NULL CHECK (terms_sha256 ~ '^[a-f0-9]{64}$'),
    dpa_sha256 text NOT NULL CHECK (dpa_sha256 ~ '^[a-f0-9]{64}$'),
    terms_html text NOT NULL,
    dpa_html text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, terms_version)
);

COMMENT ON TABLE public.terms_acceptances IS
    'Contract evidence: explicit verified-account acceptance of the Terms, including the incorporated DPA, with exact document snapshots. Retained separately from analytics; review residual records after account deletion.';
