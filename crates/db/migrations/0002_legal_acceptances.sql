-- Forward-only expansion. Existing customers accept explicitly; never infer consent.
CREATE TABLE public.legal_acceptances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text REFERENCES public."user"(id) ON DELETE SET NULL,
    customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
    customer_role text NOT NULL CHECK (customer_role IN ('controller', 'processor')),
    signer_name text NOT NULL CHECK (char_length(signer_name) BETWEEN 1 AND 200),
    signer_title text NOT NULL CHECK (char_length(signer_title) BETWEEN 1 AND 120),
    signer_email text NOT NULL,
    dpa_version text NOT NULL,
    terms_version text NOT NULL,
    dpa_sha256 text NOT NULL CHECK (dpa_sha256 ~ '^[a-f0-9]{64}$'),
    terms_sha256 text NOT NULL CHECK (terms_sha256 ~ '^[a-f0-9]{64}$'),
    dpa_html text NOT NULL,
    terms_html text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, dpa_version, terms_version)
);

COMMENT ON TABLE public.legal_acceptances IS
    'Contract evidence: explicit verified-account acceptance and exact document snapshots. Retained separately from analytics; review residual records after account deletion.';
